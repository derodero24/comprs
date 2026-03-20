#![deny(clippy::all)]

mod brotli_impl;
mod brotli_stream;
mod gzip;
mod gzip_stream;
mod zstd;
mod zstd_stream;

use napi_derive::napi;

pub use brotli_impl::*;
pub use brotli_stream::*;
pub use gzip::*;
pub use gzip_stream::*;
pub use zstd::*;
pub use zstd_stream::*;

/// Returns the library version.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
