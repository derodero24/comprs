#![deny(clippy::all)]

mod brotli_impl;
mod brotli_stream;
mod gzip;
mod gzip_stream;
mod zstd;
mod zstd_stream;

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Extract byte slice from Either<Buffer, Uint8Array>.
fn as_bytes(data: &Either<Buffer, Uint8Array>) -> &[u8] {
    match data {
        Either::A(buf) => buf.as_ref(),
        Either::B(arr) => arr.as_ref(),
    }
}

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
