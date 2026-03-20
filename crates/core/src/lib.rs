#![deny(clippy::all)]

mod zstd;
mod zstd_stream;

use napi_derive::napi;

pub use zstd::*;
pub use zstd_stream::*;

/// Returns the library version.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
