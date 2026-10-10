//! Brotli compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::async_args::{AsyncArg, Checked, checked};
use crate::convert::sync_result;
use crate::error::to_napi_error;
use crate::task::{LegacyBuffer, OneShot};

/// Compress data using Brotli.
///
/// Returns the compressed data as a Buffer.
/// Quality is an integer from 0 (fastest) to 11 (best compression). Default
/// is 6.
#[napi]
pub fn brotli_compress(
    env: Env,
    data: Either<Buffer, Uint8Array>,
    quality: Option<f64>,
) -> Result<Buffer> {
    let quality = comprs_core::brotli::QUALITY
        .check_optional_f64(quality)
        .map_err(to_napi_error)?;
    sync_result(
        &env,
        comprs_core::brotli::compress(crate::as_bytes(&data), quality),
    )
}

/// Decompress Brotli-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB.
#[napi]
pub fn brotli_decompress(env: Env, data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    sync_result(
        &env,
        comprs_core::brotli::decompress(crate::as_bytes(&data)),
    )
}

/// Decompress Brotli-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn brotli_decompress_with_capacity(
    env: Env,
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    sync_result(
        &env,
        comprs_core::brotli::decompress_with_capacity(crate::as_bytes(&data), cap),
    )
}

// --- Async tasks ---

/// Asynchronously compress data using Brotli.
///
/// Returns a Promise that resolves to the compressed data as a Buffer.
/// Quality is an integer from 0 (fastest) to 11 (best compression). Default
/// is 6.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, quality?: number | undefined | null",
    ts_return_type = "Promise<Buffer>"
)]
pub fn brotli_compress_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    quality: AsyncArg<Option<f64>>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = data.get()?;
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality.get()?)
            .map_err(to_napi_error)?;
        let data = crate::as_bytes(&data).to_vec();
        Ok(OneShot::new(move || {
            comprs_core::brotli::compress(&data, quality)
        }))
    })
}

/// Asynchronously decompress Brotli-compressed data.
///
/// Returns a Promise that resolves to the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array",
    ts_return_type = "Promise<Buffer>"
)]
pub fn brotli_decompress_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = crate::as_bytes(&data.get()?).to_vec();
        Ok(OneShot::new(move || comprs_core::brotli::decompress(&data)))
    })
}

/// Asynchronously decompress Brotli-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, capacity: number",
    ts_return_type = "Promise<Buffer>"
)]
pub fn brotli_decompress_with_capacity_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    capacity: AsyncArg<f64>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = data.get()?;
        let cap = comprs_core::validate_capacity(capacity.get()?).map_err(to_napi_error)?;
        let data = crate::as_bytes(&data).to_vec();
        Ok(OneShot::new(move || {
            comprs_core::brotli::decompress_with_capacity(&data, cap)
        }))
    })
}

// --- Dictionary compression/decompression ---

/// Compress data using Brotli with a custom dictionary.
///
/// The same dictionary must be used for decompression via `brotliDecompressWithDict`.
/// Quality is an integer from 0 (fastest) to 11 (best compression). Default
/// is 6.
#[napi]
pub fn brotli_compress_with_dict(
    env: Env,
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    quality: Option<f64>,
) -> Result<Buffer> {
    let quality = comprs_core::brotli::QUALITY
        .check_optional_f64(quality)
        .map_err(to_napi_error)?;
    sync_result(
        &env,
        comprs_core::brotli::compress_with_dict(
            crate::as_bytes(&data),
            crate::as_bytes(&dict),
            quality,
        ),
    )
}

/// Decompress Brotli-compressed data that was compressed with a custom dictionary.
///
/// The same dictionary used for compression must be provided.
#[napi]
pub fn brotli_decompress_with_dict(
    env: Env,
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
) -> Result<Buffer> {
    sync_result(
        &env,
        comprs_core::brotli::decompress_with_dict(crate::as_bytes(&data), crate::as_bytes(&dict)),
    )
}

/// Decompress Brotli-compressed data that was compressed with a custom dictionary,
/// with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
/// The same dictionary used for compression must be provided.
#[napi]
pub fn brotli_decompress_with_dict_with_capacity(
    env: Env,
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    sync_result(
        &env,
        comprs_core::brotli::decompress_with_dict_with_capacity(
            crate::as_bytes(&data),
            crate::as_bytes(&dict),
            cap,
        ),
    )
}

// --- Async tasks for dictionary compression ---

/// Asynchronously compress data using Brotli with a custom dictionary.
///
/// The same dictionary must be used for decompression via `brotliDecompressWithDict`.
/// Quality is an integer from 0 (fastest) to 11 (best compression). Default
/// is 6.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, dict: Buffer | Uint8Array, quality?: number | undefined | null",
    ts_return_type = "Promise<Buffer>"
)]
pub fn brotli_compress_with_dict_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    dict: AsyncArg<Either<Buffer, Uint8Array>>,
    quality: AsyncArg<Option<f64>>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = data.get()?;
        let dict = dict.get()?;
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality.get()?)
            .map_err(to_napi_error)?;
        let data = crate::as_bytes(&data).to_vec();
        let dict = crate::as_bytes(&dict).to_vec();
        Ok(OneShot::new(move || {
            comprs_core::brotli::compress_with_dict(&data, &dict, quality)
        }))
    })
}

/// Asynchronously decompress Brotli-compressed data that was compressed with a custom dictionary.
///
/// The same dictionary used for compression must be provided.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, dict: Buffer | Uint8Array",
    ts_return_type = "Promise<Buffer>"
)]
pub fn brotli_decompress_with_dict_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    dict: AsyncArg<Either<Buffer, Uint8Array>>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = data.get()?;
        let dict = dict.get()?;
        let data = crate::as_bytes(&data).to_vec();
        let dict = crate::as_bytes(&dict).to_vec();
        Ok(OneShot::new(move || {
            comprs_core::brotli::decompress_with_dict(&data, &dict)
        }))
    })
}

/// Asynchronously decompress Brotli-compressed data that was compressed with a custom dictionary,
/// with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
/// The same dictionary used for compression must be provided.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, dict: Buffer | Uint8Array, capacity: number",
    ts_return_type = "Promise<Buffer>"
)]
pub fn brotli_decompress_with_dict_with_capacity_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    dict: AsyncArg<Either<Buffer, Uint8Array>>,
    capacity: AsyncArg<f64>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = data.get()?;
        let dict = dict.get()?;
        let cap = comprs_core::validate_capacity(capacity.get()?).map_err(to_napi_error)?;
        let data = crate::as_bytes(&data).to_vec();
        let dict = crate::as_bytes(&dict).to_vec();
        Ok(OneShot::new(move || {
            comprs_core::brotli::decompress_with_dict_with_capacity(&data, &dict, cap)
        }))
    })
}
