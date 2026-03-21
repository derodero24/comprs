#![deny(clippy::all)]

mod brotli_impl;
mod brotli_stream;
mod crc;
mod detect;
mod error;
mod gzip;
mod gzip_stream;
mod zstd;
mod zstd_stream;

use napi::bindgen_prelude::*;
use napi_derive::napi;

pub use error::ZflateError;

/// Maximum allowed decompressed size (256 MB) to prevent memory exhaustion.
const MAX_DECOMPRESSED_SIZE: usize = 256 * 1024 * 1024;

/// Extract byte slice from Either<Buffer, Uint8Array>.
fn as_bytes(data: &Either<Buffer, Uint8Array>) -> &[u8] {
    match data {
        Either::A(buf) => buf.as_ref(),
        Either::B(arr) => arr.as_ref(),
    }
}

/// Validate and return the max output size, defaulting to MAX_DECOMPRESSED_SIZE.
fn validate_max_output_size(max_output_size: Option<f64>) -> Result<usize> {
    match max_output_size {
        None => Ok(MAX_DECOMPRESSED_SIZE),
        Some(size) => {
            if !size.is_finite() || size < 0.0 {
                Err(ZflateError::InvalidArg(
                    "maxOutputSize must be a positive finite number".to_string(),
                )
                .into())
            } else {
                Ok(size as usize)
            }
        }
    }
}

pub use brotli_impl::*;
pub use brotli_stream::*;
pub use crc::*;
pub use detect::*;
pub use gzip::*;
pub use gzip_stream::*;
pub use zstd::*;
pub use zstd_stream::*;

/// Returns the library version.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
