//! cftcp patch: tokio's time driver needs a tokio runtime, which we don't have
//! on wasm32-unknown-unknown (futures are driven by the JS event loop via
//! wasm-bindgen-futures). Route timers through wasmtimer (setTimeout-backed).
#[cfg(not(target_arch = "wasm32"))]
pub use tokio::time::*;

#[cfg(target_arch = "wasm32")]
pub use wasmtimer::tokio::{error, interval, sleep, timeout, Interval, Sleep};
#[cfg(target_arch = "wasm32")]
pub use wasmtimer::std::Instant;

/// cftcp patch: a deadline that has already passed resolves right away instead
/// of going through wasmtimer, whose timers can stop firing in workerd after an
/// earlier session's timers were dropped (seen as auth rejections that never arrive).
#[cfg(target_arch = "wasm32")]
pub async fn sleep_until(deadline: Instant) {
    if deadline > Instant::now() {
        wasmtimer::tokio::sleep_until(deadline).await;
    }
}
