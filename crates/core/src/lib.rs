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

use std::io::Read;

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

/// Decompress data from a reader with a size limit.
///
/// Uses `Read::read_to_end` to write directly into the output Vec's spare
/// capacity, avoiding the double-copy through an intermediate stack buffer.
/// The `Take` wrapper enforces the size limit without per-chunk checking.
fn decompress_with_limit(
    decoder: impl Read,
    max_size: usize,
    init_cap: usize,
    context: &'static str,
) -> Result<Vec<u8>> {
    let mut output = Vec::with_capacity(init_cap);
    decoder
        .take((max_size as u64).saturating_add(1))
        .read_to_end(&mut output)
        .map_err(|e| {
            napi::Error::from(ZflateError::Operation {
                context,
                source: e.into(),
            })
        })?;
    if output.len() > max_size {
        return Err(ZflateError::SizeLimit {
            context,
            limit: max_size,
        }
        .into());
    }
    Ok(output)
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
