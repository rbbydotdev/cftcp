//! cftcp patch: tokio's time driver needs a tokio runtime, which we don't have
//! on wasm32-unknown-unknown (futures are driven by the JS event loop via
//! wasm-bindgen-futures). Route timers through wasmtimer (setTimeout-backed).
#[cfg(not(target_arch = "wasm32"))]
pub use tokio::time::*;

#[cfg(target_arch = "wasm32")]
pub use wasmtimer::tokio::*;
#[cfg(target_arch = "wasm32")]
pub use wasmtimer::std::Instant;
