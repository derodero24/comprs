//! LZ4 frame compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::async_args::{AsyncArg, Checked, checked};
use crate::convert::sync_result;
use crate::error::to_napi_error;
use crate::task::{LegacyBuffer, OneShot};

/// Compress data using LZ4 frame format.
///
/// Returns the compressed data as a Buffer. The frame carries a content
/// checksum, as the `lz4` CLI writes by default.
#[napi]
pub fn lz4_compress(env: Env, data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    sync_result(&env, comprs_core::lz4::compress(crate::as_bytes(&data)))
}

/// Decompress LZ4 frame-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The input may hold several concatenated frames, including skippable and
/// legacy frames. The maximum decompressed size is 256 MB. Use
/// `lz4DecompressWithCapacity` for larger data.
#[napi]
pub fn lz4_decompress(env: Env, data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    sync_result(&env, comprs_core::lz4::decompress(crate::as_bytes(&data)))
}

/// Decompress LZ4 frame-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn lz4_decompress_with_capacity(
    env: Env,
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    sync_result(
        &env,
        comprs_core::lz4::decompress_with_capacity(crate::as_bytes(&data), cap),
    )
}

// --- Async tasks ---

/// Asynchronously compress data using LZ4 frame format.
///
/// Returns a Promise that resolves to the compressed data as a Buffer. The
/// frame carries a content checksum, as the `lz4` CLI writes by default.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array",
    ts_return_type = "Promise<Buffer>"
)]
pub fn lz4_compress_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = crate::as_bytes(&data.get()?).to_vec();
        Ok(OneShot::new(move || comprs_core::lz4::compress(&data)))
    })
}

/// Asynchronously decompress LZ4 frame-compressed data.
///
/// Returns a Promise that resolves to the decompressed data as a Buffer.
/// The input may hold several concatenated frames, including skippable and
/// legacy frames. The maximum decompressed size is 256 MB. Use
/// `lz4DecompressWithCapacityAsync` for larger data.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array",
    ts_return_type = "Promise<Buffer>"
)]
pub fn lz4_decompress_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = crate::as_bytes(&data.get()?).to_vec();
        Ok(OneShot::new(move || comprs_core::lz4::decompress(&data)))
    })
}

/// Asynchronously decompress LZ4 frame-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, capacity: number",
    ts_return_type = "Promise<Buffer>"
)]
pub fn lz4_decompress_with_capacity_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    capacity: AsyncArg<f64>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = data.get()?;
        let cap = comprs_core::validate_capacity(capacity.get()?).map_err(to_napi_error)?;
        let data = crate::as_bytes(&data).to_vec();
        Ok(OneShot::new(move || {
            comprs_core::lz4::decompress_with_capacity(&data, cap)
        }))
    })
}
