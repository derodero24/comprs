//! CRC32 (IEEE polynomial) utility.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::error::to_napi_error;

/// Compute CRC32 checksum of the given data.
///
/// Optionally accepts an initial CRC value for incremental computation:
/// split data into chunks, pass the result of each chunk as `initial_value`
/// for the next. `initial_value` is an integer from 0 to 4294967295.
#[napi]
pub fn crc32(data: Either<Buffer, Uint8Array>, initial_value: Option<f64>) -> Result<u32> {
    let initial_value = comprs_core::crc::INITIAL_VALUE
        .check_optional_f64(initial_value)
        .map_err(to_napi_error)?;
    Ok(comprs_core::crc::crc32(
        crate::as_bytes(&data),
        initial_value,
    ))
}
