//! Zstandard compression and decompression.

use napi::Task;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::error::to_napi_error;

/// Compress data using Zstandard.
///
/// Returns the compressed data as a Buffer.
/// Level ranges from 1 (fastest) to 22 (best compression). Default is 3.
/// Negative levels (e.g., -1 to -131072) enable fast mode, trading compression
/// ratio for speed. Level 0 is equivalent to the default level (3).
#[napi]
pub fn zstd_compress(data: Either<Buffer, Uint8Array>, level: Option<i32>) -> Result<Buffer> {
    comprs_core::zstd::compress(crate::as_bytes(&data), level)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

pub struct ZstdCompressTask {
    data: Vec<u8>,
    level: Option<i32>,
}

#[napi]
impl Task for ZstdCompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::zstd::compress(&self.data, self.level).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously compress data using Zstandard.
///
/// Returns a Promise that resolves to the compressed data as a Buffer.
/// Level ranges from 1 (fastest) to 22 (best compression). Default is 3.
/// Negative levels (e.g., -1 to -131072) enable fast mode, trading compression
/// ratio for speed. Level 0 is equivalent to the default level (3).
#[napi]
pub fn zstd_compress_async(
    data: Either<Buffer, Uint8Array>,
    level: Option<i32>,
) -> Result<AsyncTask<ZstdCompressTask>> {
    // Validate level eagerly
    let lvl = level.unwrap_or(comprs_core::zstd::DEFAULT_LEVEL);
    if !(-131072..=22).contains(&lvl) {
        return Err(to_napi_error(comprs_core::ComprsError::InvalidArg(
            "zstd compression level must be between -131072 and 22".to_string(),
        )));
    }
    let input = crate::as_bytes(&data).to_vec();
    Ok(AsyncTask::new(ZstdCompressTask { data: input, level }))
}

pub struct ZstdDecompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for ZstdDecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::zstd::decompress(&self.data).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress Zstandard-compressed data.
///
/// Returns a Promise that resolves to the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `zstdDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn zstd_decompress_async(data: Either<Buffer, Uint8Array>) -> AsyncTask<ZstdDecompressTask> {
    let input = crate::as_bytes(&data).to_vec();
    AsyncTask::new(ZstdDecompressTask { data: input })
}

/// Decompress Zstandard-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `zstdDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn zstd_decompress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    comprs_core::zstd::decompress(crate::as_bytes(&data))
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Decompress Zstandard-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn zstd_decompress_with_capacity(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    comprs_core::zstd::decompress_with_capacity(crate::as_bytes(&data), cap)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Train a zstd dictionary from sample data.
///
/// The dictionary can be used with `zstdCompressWithDict` and `zstdDecompressWithDict`
/// to achieve better compression ratios on small, similar data.
///
/// `maxDictSize` is optional and defaults to 110 KB (the zstd default).
#[napi]
pub fn zstd_train_dictionary(
    samples: Vec<Either<Buffer, Uint8Array>>,
    max_dict_size: Option<f64>,
) -> Result<Buffer> {
    let max_size = max_dict_size
        .map(|s| comprs_core::validate_capacity(s).map_err(to_napi_error))
        .transpose()?
        .unwrap_or(comprs_core::zstd::DEFAULT_MAX_DICT_SIZE);

    let sample_vecs: Vec<Vec<u8>> = samples
        .iter()
        .map(|s| crate::as_bytes(s).to_vec())
        .collect();

    comprs_core::zstd::train_dictionary(&sample_vecs, max_size)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Compress data using Zstandard with a pre-trained dictionary.
///
/// The same dictionary must be used for decompression via `zstdDecompressWithDict`.
/// Level ranges from 1 (fastest) to 22 (best compression). Default is 3.
#[napi]
pub fn zstd_compress_with_dict(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    level: Option<i32>,
) -> Result<Buffer> {
    comprs_core::zstd::compress_with_dict(crate::as_bytes(&data), crate::as_bytes(&dict), level)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Decompress Zstandard-compressed data that was compressed with a dictionary.
///
/// The same dictionary used for compression must be provided.
#[napi]
pub fn zstd_decompress_with_dict(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
) -> Result<Buffer> {
    comprs_core::zstd::decompress_with_dict(crate::as_bytes(&data), crate::as_bytes(&dict))
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Decompress Zstandard-compressed data that was compressed with a dictionary,
/// with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
/// The same dictionary used for compression must be provided.
#[napi]
pub fn zstd_decompress_with_dict_with_capacity(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    comprs_core::zstd::decompress_with_dict_with_capacity(
        crate::as_bytes(&data),
        crate::as_bytes(&dict),
        cap,
    )
    .map(|v| v.into())
    .map_err(to_napi_error)
}

pub struct ZstdDecompressWithCapacityTask {
    data: Vec<u8>,
    capacity: usize,
}

#[napi]
impl Task for ZstdDecompressWithCapacityTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::zstd::decompress_with_capacity(&self.data, self.capacity)
            .map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress Zstandard-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn zstd_decompress_with_capacity_async(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<AsyncTask<ZstdDecompressWithCapacityTask>> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    let input = crate::as_bytes(&data).to_vec();
    Ok(AsyncTask::new(ZstdDecompressWithCapacityTask {
        data: input,
        capacity: cap,
    }))
}

pub struct ZstdCompressWithDictTask {
    data: Vec<u8>,
    dict: Vec<u8>,
    level: Option<i32>,
}

#[napi]
impl Task for ZstdCompressWithDictTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::zstd::compress_with_dict(&self.data, &self.dict, self.level)
            .map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously compress data using Zstandard with a pre-trained dictionary.
///
/// The same dictionary must be used for decompression via `zstdDecompressWithDict`.
/// Level ranges from 1 (fastest) to 22 (best compression). Default is 3.
#[napi]
pub fn zstd_compress_with_dict_async(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    level: Option<i32>,
) -> Result<AsyncTask<ZstdCompressWithDictTask>> {
    // Validate level eagerly
    let lvl = level.unwrap_or(comprs_core::zstd::DEFAULT_LEVEL);
    if !(-131072..=22).contains(&lvl) {
        return Err(to_napi_error(comprs_core::ComprsError::InvalidArg(
            "zstd compression level must be between -131072 and 22".to_string(),
        )));
    }
    let input = crate::as_bytes(&data).to_vec();
    let dict_bytes = crate::as_bytes(&dict).to_vec();
    Ok(AsyncTask::new(ZstdCompressWithDictTask {
        data: input,
        dict: dict_bytes,
        level,
    }))
}

pub struct ZstdDecompressWithDictTask {
    data: Vec<u8>,
    dict: Vec<u8>,
}

#[napi]
impl Task for ZstdDecompressWithDictTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::zstd::decompress_with_dict(&self.data, &self.dict).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress Zstandard-compressed data that was compressed with a dictionary.
///
/// The same dictionary used for compression must be provided.
#[napi]
pub fn zstd_decompress_with_dict_async(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
) -> AsyncTask<ZstdDecompressWithDictTask> {
    let input = crate::as_bytes(&data).to_vec();
    let dict_bytes = crate::as_bytes(&dict).to_vec();
    AsyncTask::new(ZstdDecompressWithDictTask {
        data: input,
        dict: dict_bytes,
    })
}

pub struct ZstdTrainDictionaryTask {
    samples: Vec<Vec<u8>>,
    max_dict_size: usize,
}

#[napi]
impl Task for ZstdTrainDictionaryTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::zstd::train_dictionary(&self.samples, self.max_dict_size)
            .map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously train a zstd dictionary from sample data.
///
/// The dictionary can be used with `zstdCompressWithDict` and `zstdDecompressWithDict`
/// to achieve better compression ratios on small, similar data.
///
/// `maxDictSize` is optional and defaults to 110 KB (the zstd default).
#[napi]
pub fn zstd_train_dictionary_async(
    samples: Vec<Either<Buffer, Uint8Array>>,
    max_dict_size: Option<f64>,
) -> Result<AsyncTask<ZstdTrainDictionaryTask>> {
    let max_size = max_dict_size
        .map(|s| comprs_core::validate_capacity(s).map_err(to_napi_error))
        .transpose()?
        .unwrap_or(comprs_core::zstd::DEFAULT_MAX_DICT_SIZE);
    let sample_vecs: Vec<Vec<u8>> = samples
        .iter()
        .map(|s| crate::as_bytes(s).to_vec())
        .collect();
    Ok(AsyncTask::new(ZstdTrainDictionaryTask {
        samples: sample_vecs,
        max_dict_size: max_size,
    }))
}

pub struct ZstdDecompressWithDictWithCapacityTask {
    data: Vec<u8>,
    dict: Vec<u8>,
    capacity: usize,
}

#[napi]
impl Task for ZstdDecompressWithDictWithCapacityTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::zstd::decompress_with_dict_with_capacity(&self.data, &self.dict, self.capacity)
            .map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress Zstandard-compressed data that was compressed with a dictionary,
/// with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
/// The same dictionary used for compression must be provided.
#[napi]
pub fn zstd_decompress_with_dict_with_capacity_async(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<AsyncTask<ZstdDecompressWithDictWithCapacityTask>> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    let input = crate::as_bytes(&data).to_vec();
    let dict_bytes = crate::as_bytes(&dict).to_vec();
    Ok(AsyncTask::new(ZstdDecompressWithDictWithCapacityTask {
        data: input,
        dict: dict_bytes,
        capacity: cap,
    }))
}
