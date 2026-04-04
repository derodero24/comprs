//! CRC32 (IEEE polynomial) utility.

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Compute CRC32 checksum of the given data.
///
/// Optionally accepts an initial CRC value for incremental computation:
/// split data into chunks, pass the result of each chunk as `initial_value`
/// for the next.
#[napi]
pub fn crc32(data: Either<Buffer, Uint8Array>, initial_value: Option<u32>) -> u32 {
    comprs_core::crc::crc32(crate::as_bytes(&data), initial_value)
}
