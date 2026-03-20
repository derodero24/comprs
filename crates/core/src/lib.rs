#![deny(clippy::all)]

mod zstd;

use napi_derive::napi;

pub use zstd::*;

/// Returns the library version.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
