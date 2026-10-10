//! Zstandard compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::async_args::{AsyncArg, Checked, checked};
use crate::convert::sync_result;
use crate::error::to_napi_error;
use crate::task::{LegacyBuffer, OneShot};

/// Compress data using Zstandard.
///
/// Returns the compressed data as a Buffer.
/// Level is an integer from 1 (fastest) to 22 (best compression). Default is
/// 3. Negative levels (-1 to -131072) enable fast mode, trading compression
/// ratio for speed. Level 0 is equivalent to the default level (3).
#[napi]
pub fn zstd_compress(
    env: Env,
    data: Either<Buffer, Uint8Array>,
    level: Option<f64>,
) -> Result<Buffer> {
    let level = comprs_core::zstd::LEVEL
        .check_optional_f64(level)
        .map_err(to_napi_error)?;
    sync_result(
        &env,
        comprs_core::zstd::compress(crate::as_bytes(&data), level),
    )
}

/// Asynchronously compress data using Zstandard.
///
/// Returns a Promise that resolves to the compressed data as a Buffer.
/// Level is an integer from 1 (fastest) to 22 (best compression). Default is
/// 3. Negative levels (-1 to -131072) enable fast mode, trading compression
/// ratio for speed. Level 0 is equivalent to the default level (3).
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, level?: number | undefined | null",
    ts_return_type = "Promise<Buffer>"
)]
pub fn zstd_compress_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    level: AsyncArg<Option<f64>>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = data.get()?;
        let level = comprs_core::zstd::LEVEL
            .check_optional_f64(level.get()?)
            .map_err(to_napi_error)?;
        let data = crate::as_bytes(&data).to_vec();
        Ok(OneShot::new(move || {
            comprs_core::zstd::compress(&data, level)
        }))
    })
}

/// Asynchronously decompress Zstandard-compressed data.
///
/// Returns a Promise that resolves to the decompressed data as a Buffer.
/// The input may hold several concatenated frames, including skippable
/// frames. The maximum decompressed size is 256 MB. Use
/// `zstdDecompressWithCapacity` for larger data.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array",
    ts_return_type = "Promise<Buffer>"
)]
pub fn zstd_decompress_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = crate::as_bytes(&data.get()?).to_vec();
        Ok(OneShot::new(move || comprs_core::zstd::decompress(&data)))
    })
}

/// Decompress Zstandard-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The input may hold several concatenated frames, including skippable
/// frames. The maximum decompressed size is 256 MB. Use
/// `zstdDecompressWithCapacity` for larger data.
#[napi]
pub fn zstd_decompress(env: Env, data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    sync_result(&env, comprs_core::zstd::decompress(crate::as_bytes(&data)))
}

/// Decompress Zstandard-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
/// It is only a limit: the output buffer grows with the decompressed data, so
/// a large `capacity` reserves no memory up front. `capacity` also bounds the
/// window that a frame makes the decoder allocate before it writes any
/// output: to `capacity` rounded up to a power of two, at least 8 MiB and at
/// most zstd's default of 128 MiB, so a frame that declares a larger window
/// throws an error instead.
#[napi]
pub fn zstd_decompress_with_capacity(
    env: Env,
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    sync_result(
        &env,
        comprs_core::zstd::decompress_with_capacity(crate::as_bytes(&data), cap),
    )
}

/// Train a zstd dictionary from sample data.
///
/// The dictionary can be used with `zstdCompressWithDict` and `zstdDecompressWithDict`
/// to achieve better compression ratios on small, similar data.
///
/// `maxDictSize` is optional and defaults to 110 KB (the zstd default). It
/// must not exceed 16 MiB (16777216 bytes).
#[napi]
pub fn zstd_train_dictionary(
    env: Env,
    samples: Vec<Either<Buffer, Uint8Array>>,
    max_dict_size: Option<f64>,
) -> Result<Buffer> {
    let max_size = comprs_core::zstd::DICT_SIZE
        .check_optional_f64(max_dict_size)
        .map_err(to_napi_error)?
        .unwrap_or(comprs_core::zstd::DEFAULT_MAX_DICT_SIZE);

    let sample_vecs: Vec<Vec<u8>> = samples
        .iter()
        .map(|s| crate::as_bytes(s).to_vec())
        .collect();

    sync_result(
        &env,
        comprs_core::zstd::train_dictionary(&sample_vecs, max_size),
    )
}

/// Compress data using Zstandard with a pre-trained dictionary.
///
/// The same dictionary must be used for decompression via `zstdDecompressWithDict`.
/// Level is an integer from -131072 to 22, as for `zstdCompress`. Default is
/// 3.
#[napi]
pub fn zstd_compress_with_dict(
    env: Env,
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    level: Option<f64>,
) -> Result<Buffer> {
    let level = comprs_core::zstd::LEVEL
        .check_optional_f64(level)
        .map_err(to_napi_error)?;
    sync_result(
        &env,
        comprs_core::zstd::compress_with_dict(
            crate::as_bytes(&data),
            crate::as_bytes(&dict),
            level,
        ),
    )
}

/// Decompress Zstandard-compressed data that was compressed with a dictionary.
///
/// The same dictionary used for compression must be provided.
#[napi]
pub fn zstd_decompress_with_dict(
    env: Env,
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
) -> Result<Buffer> {
    sync_result(
        &env,
        comprs_core::zstd::decompress_with_dict(crate::as_bytes(&data), crate::as_bytes(&dict)),
    )
}

/// Decompress Zstandard-compressed data that was compressed with a dictionary,
/// with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
/// It is only a limit: the output buffer grows with the decompressed data, so
/// a large `capacity` reserves no memory up front. `capacity` also bounds the
/// window that a frame makes the decoder allocate before it writes any
/// output: to `capacity` rounded up to a power of two, at least 8 MiB and at
/// most zstd's default of 128 MiB, so a frame that declares a larger window
/// throws an error instead.
/// The same dictionary used for compression must be provided.
#[napi]
pub fn zstd_decompress_with_dict_with_capacity(
    env: Env,
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    sync_result(
        &env,
        comprs_core::zstd::decompress_with_dict_with_capacity(
            crate::as_bytes(&data),
            crate::as_bytes(&dict),
            cap,
        ),
    )
}

/// Asynchronously decompress Zstandard-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
/// It is only a limit: the output buffer grows with the decompressed data, so
/// a large `capacity` reserves no memory up front. `capacity` also bounds the
/// window that a frame makes the decoder allocate before it writes any
/// output: to `capacity` rounded up to a power of two, at least 8 MiB and at
/// most zstd's default of 128 MiB, so for a frame that declares a larger
/// window the promise rejects with an error instead.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, capacity: number",
    ts_return_type = "Promise<Buffer>"
)]
pub fn zstd_decompress_with_capacity_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    capacity: AsyncArg<f64>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = data.get()?;
        let cap = comprs_core::validate_capacity(capacity.get()?).map_err(to_napi_error)?;
        let data = crate::as_bytes(&data).to_vec();
        Ok(OneShot::new(move || {
            comprs_core::zstd::decompress_with_capacity(&data, cap)
        }))
    })
}

/// Asynchronously compress data using Zstandard with a pre-trained dictionary.
///
/// The same dictionary must be used for decompression via `zstdDecompressWithDict`.
/// Level is an integer from -131072 to 22, as for `zstdCompress`. Default is
/// 3.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, dict: Buffer | Uint8Array, level?: number | undefined | null",
    ts_return_type = "Promise<Buffer>"
)]
pub fn zstd_compress_with_dict_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    dict: AsyncArg<Either<Buffer, Uint8Array>>,
    level: AsyncArg<Option<f64>>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = data.get()?;
        let dict = dict.get()?;
        let level = comprs_core::zstd::LEVEL
            .check_optional_f64(level.get()?)
            .map_err(to_napi_error)?;
        let data = crate::as_bytes(&data).to_vec();
        let dict = crate::as_bytes(&dict).to_vec();
        Ok(OneShot::new(move || {
            comprs_core::zstd::compress_with_dict(&data, &dict, level)
        }))
    })
}

/// Asynchronously decompress Zstandard-compressed data that was compressed with a dictionary.
///
/// The same dictionary used for compression must be provided.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, dict: Buffer | Uint8Array",
    ts_return_type = "Promise<Buffer>"
)]
pub fn zstd_decompress_with_dict_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    dict: AsyncArg<Either<Buffer, Uint8Array>>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let data = data.get()?;
        let dict = dict.get()?;
        let data = crate::as_bytes(&data).to_vec();
        let dict = crate::as_bytes(&dict).to_vec();
        Ok(OneShot::new(move || {
            comprs_core::zstd::decompress_with_dict(&data, &dict)
        }))
    })
}

/// Asynchronously train a zstd dictionary from sample data.
///
/// The dictionary can be used with `zstdCompressWithDict` and `zstdDecompressWithDict`
/// to achieve better compression ratios on small, similar data.
///
/// `maxDictSize` is optional and defaults to 110 KB (the zstd default). It
/// must not exceed 16 MiB (16777216 bytes).
#[napi(
    ts_args_type = "samples: Array<Buffer | Uint8Array>, maxDictSize?: number | undefined | null",
    ts_return_type = "Promise<Buffer>"
)]
pub fn zstd_train_dictionary_async(
    samples: AsyncArg<Vec<Either<Buffer, Uint8Array>>>,
    max_dict_size: AsyncArg<Option<f64>>,
) -> AsyncTask<Checked<OneShot<LegacyBuffer>>> {
    checked(|| {
        let samples = samples.get()?;
        let max_size = comprs_core::zstd::DICT_SIZE
            .check_optional_f64(max_dict_size.get()?)
            .map_err(to_napi_error)?
            .unwrap_or(comprs_core::zstd::DEFAULT_MAX_DICT_SIZE);
        let sample_vecs: Vec<Vec<u8>> = samples
            .iter()
            .map(|s| crate::as_bytes(s).to_vec())
            .collect();
        Ok(OneShot::new(move || {
            comprs_core::zstd::train_dictionary(&sample_vecs, max_size)
        }))
    })
}

/// Asynchronously decompress Zstandard-compressed data that was compressed with a dictionary,
/// with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
/// It is only a limit: the output buffer grows with the decompressed data, so
/// a large `capacity` reserves no memory up front. `capacity` also bounds the
/// window that a frame makes the decoder allocate before it writes any
/// output: to `capacity` rounded up to a power of two, at least 8 MiB and at
/// most zstd's default of 128 MiB, so for a frame that declares a larger
/// window the promise rejects with an error instead.
/// The same dictionary used for compression must be provided.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, dict: Buffer | Uint8Array, capacity: number",
    ts_return_type = "Promise<Buffer>"
)]
pub fn zstd_decompress_with_dict_with_capacity_async(
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
            comprs_core::zstd::decompress_with_dict_with_capacity(&data, &dict, cap)
        }))
    })
}
