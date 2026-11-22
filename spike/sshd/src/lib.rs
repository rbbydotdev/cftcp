//! A russh SSH server compiled to wasm32-unknown-unknown and driven by the JS
//! event loop (wasm-bindgen-futures). JS hands us a socket's readable/writable
//! streams plus a `shell` object; we speak SSH and relay channel bytes to it.
use std::sync::Arc;

use futures::TryStreamExt;
use russh::keys::{PrivateKey, PublicKey};
use russh::server::{Auth, ChannelOpenHandle, Handler, Msg, PublicKeyOffer, Session, VerifiedPublicKey};
use russh::{MethodKind, MethodSet};
use russh::{Channel, ChannelId, Pty};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use wasm_bindgen::prelude::*;

/// Events the (Send) russh handler forwards to the (non-Send) JS pump task.
enum Event {
    Open { channel: ChannelId, handle: russh::server::Handle, user: String, cols: u32, rows: u32 },
    Data { channel: ChannelId, data: Vec<u8> },
    Resize { channel: ChannelId, cols: u32, rows: u32 },
    Close { channel: ChannelId },
}

struct Server {
    tx: mpsc::UnboundedSender<Event>,
    user: String,
    pty: (u32, u32),
    authorized: Vec<PublicKey>,
}

impl Server {
    /// No authorized keys configured => open box (local spike only).
    fn is_authorized(&self, key: &PublicKey) -> bool {
        self.authorized.is_empty() || self.authorized.iter().any(|k| k.key_data() == key.key_data())
    }
}

impl Handler for Server {
    type Error = russh::Error;

    async fn auth_publickey_offered(&mut self, _user: &str, offer: PublicKeyOffer<'_>) -> Result<Auth, Self::Error> {
        Ok(if self.is_authorized(offer.public_key) { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_publickey(&mut self, user: &str, key: VerifiedPublicKey<'_>) -> Result<Auth, Self::Error> {
        if self.is_authorized(key.public_key) {
            self.user = user.to_string();
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self, _c: Channel<Msg>, reply: ChannelOpenHandle, _s: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self, channel: ChannelId, _term: &str, cols: u32, rows: u32, _pw: u32, _ph: u32,
        _modes: &[(Pty, u32)], session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.pty = (cols, rows);
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let _ = self.tx.send(Event::Open {
            channel, handle: session.handle(), user: self.user.clone(), cols: self.pty.0, rows: self.pty.1,
        });
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], _s: &mut Session) -> Result<(), Self::Error> {
        let _ = self.tx.send(Event::Data { channel, data: data.to_vec() });
        Ok(())
    }

    async fn window_change_request(
        &mut self, channel: ChannelId, cols: u32, rows: u32, _pw: u32, _ph: u32, _s: &mut Session,
    ) -> Result<(), Self::Error> {
        let _ = self.tx.send(Event::Resize { channel, cols, rows });
        Ok(())
    }

    async fn channel_eof(&mut self, channel: ChannelId, _s: &mut Session) -> Result<(), Self::Error> {
        let _ = self.tx.send(Event::Close { channel });
        Ok(())
    }
}

/// Generate a new ed25519 host key, returned in OpenSSH PEM form for storage.
#[wasm_bindgen(js_name = generateHostKey)]
pub fn generate_host_key() -> Result<String, JsError> {
    console_error_panic_hook::set_once();
    let mut seed = [0u8; 32];
    getrandom_02::getrandom(&mut seed).map_err(|e| JsError::new(&e.to_string()))?;
    let key = PrivateKey::from(russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&seed));
    Ok(key.to_openssh(russh::keys::ssh_key::LineEnding::LF).map_err(|e| JsError::new(&e.to_string()))?.to_string())
}

#[wasm_bindgen]
extern "C" {
    /// JS side of a terminal session:
    ///   open(user, cols, rows) -> Promise<Uint8Array>   (initial output, e.g. banner+prompt)
    ///   input(bytes)           -> Promise<Uint8Array|null> (output; null => exit)
    ///   resize(cols, rows)
    ///   read()                 -> Promise<Uint8Array|null>  (optional: streamed output; null => exit)
    #[derive(Clone)]
    pub type Shell;
    #[wasm_bindgen(method, catch)]
    async fn open(this: &Shell, user: &str, cols: u32, rows: u32) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, catch)]
    async fn input(this: &Shell, data: &[u8]) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method)]
    fn resize(this: &Shell, cols: u32, rows: u32);
    #[wasm_bindgen(method, catch)]
    async fn read(this: &Shell) -> Result<JsValue, JsValue>;
}

/// Close a channel the way a shell exit would.
async fn end_channel(h: &russh::server::Handle, ch: ChannelId, status: u32) {
    let _ = h.exit_status_request(ch, status).await;
    let _ = h.eof(ch).await;
    let _ = h.close(ch).await;
}

/// Serve one SSH connection over a JS socket until it closes.
#[wasm_bindgen]
pub async fn serve(
    readable: web_sys_stub::ReadableStream,
    writable: web_sys_stub::WritableStream,
    host_key: String,
    authorized_keys: String,
    shell: Shell,
) -> Result<(), JsError> {
    console_error_panic_hook::set_once();
    let key = PrivateKey::from_openssh(&host_key).map_err(|e| JsError::new(&e.to_string()))?;
    let authorized = authorized_keys
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .filter_map(|l| PublicKey::from_openssh(l).ok())
        .collect();

    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        methods: MethodSet::from(&[MethodKind::PublicKey][..]),
        server_id: russh::SshId::Standard("SSH-2.0-cftcp_0.1".into()),
        auth_rejection_time: std::time::Duration::from_millis(500),
        auth_rejection_time_initial: Some(std::time::Duration::from_millis(0)),
        inactivity_timeout: Some(std::time::Duration::from_secs(3600)),
        ..Default::default()
    });

    // Bridge the !Send JS streams to a Send in-memory duplex that russh owns.
    let (ours, theirs) = tokio::io::duplex(64 * 1024);
    let (mut duplex_r, mut duplex_w) = tokio::io::split(ours);
    let js_r = wasm_streams::ReadableStream::from_raw(readable.unchecked_into())
        .into_stream()
        .map_ok(|v| bytes::Bytes::from(js_sys::Uint8Array::new(&v).to_vec()))
        .map_err(|e| std::io::Error::other(format!("{e:?}")));
    let mut js_r = tokio_util::io::StreamReader::new(js_r);
    let mut js_w = tokio_util::compat::FuturesAsyncWriteCompatExt::compat_write(
        wasm_streams::WritableStream::from_raw(writable.unchecked_into()).into_async_write(),
    );
    let inbound = async move {
        let _ = tokio::io::copy(&mut js_r, &mut duplex_w).await;
        let _ = duplex_w.shutdown().await;
    };
    let outbound = async move {
        let _ = tokio::io::copy(&mut duplex_r, &mut js_w).await;
        let _ = js_w.shutdown().await;
    };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let handler = Server { tx, user: String::new(), pty: (80, 24), authorized };
    let session = async move {
        match russh::server::run_stream(config, theirs, handler).await {
            Ok(running) => {
                if let Err(e) = running.await {
                    log(&format!("ssh session ended: {e}"));
                }
            }
            Err(e) => log(&format!("ssh handshake failed: {e}")),
        }
    };

    // Pump events to the JS shell (runs on the JS thread; may hold !Send values).
    let pump = async move {
        let mut handle: Option<(ChannelId, russh::server::Handle)> = None;
        while let Some(ev) = rx.recv().await {
            match ev {
                Event::Open { channel, handle: h, user, cols, rows } => {
                    let out = shell.open(&user, cols, rows).await;
                    if let Ok(out) = out {
                        let _ = h.data(channel, js_sys::Uint8Array::new(&out).to_vec()).await;
                    }
                    // Shells with their own output stream (e.g. a pty) get a reader task.
                    let has_read = js_sys::Reflect::get(&shell, &"read".into()).map(|f| f.is_function()).unwrap_or(false);
                    if has_read {
                        let (shell, h) = (shell.clone(), h.clone());
                        wasm_bindgen_futures::spawn_local(async move {
                            loop {
                                match shell.read().await {
                                    Ok(out) if out.is_null() || out.is_undefined() => break,
                                    Ok(out) => {
                                        if h.data(channel, js_sys::Uint8Array::new(&out).to_vec()).await.is_err() {
                                            return;
                                        }
                                    }
                                    Err(e) => { log(&format!("shell read error: {e:?}")); break; }
                                }
                            }
                            end_channel(&h, channel, 0).await;
                        });
                    }
                    handle = Some((channel, h));
                }
                Event::Data { data, .. } => {
                    let Some((ch, h)) = &handle else { continue };
                    match shell.input(&data).await {
                        Ok(out) if out.is_null() || out.is_undefined() => end_channel(h, *ch, 0).await,
                        Ok(out) => {
                            let bytes = js_sys::Uint8Array::new(&out).to_vec();
                            if !bytes.is_empty() {
                                let _ = h.data(*ch, bytes).await;
                            }
                        }
                        Err(e) => log(&format!("shell error: {e:?}")),
                    }
                }
                Event::Resize { cols, rows, .. } => shell.resize(cols, rows),
                Event::Close { channel } => {
                    if let Some((_, h)) = &handle {
                        let _ = h.close(channel).await;
                    }
                }
            }
        }
    };

    futures::join!(inbound, outbound, session, pump);
    Ok(())
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

/// Minimal stand-ins so we don't pull all of web-sys.
mod web_sys_stub {
    use wasm_bindgen::prelude::*;
    #[wasm_bindgen]
    extern "C" {
        #[derive(Clone)]
        pub type ReadableStream;
        #[derive(Clone)]
        pub type WritableStream;
    }
}
