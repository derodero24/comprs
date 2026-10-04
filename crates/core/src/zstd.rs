//! Zstandard compression and decompression.

use napi::Task;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::async_args::{AsyncArg, Checked, checked};
use crate::error::to_napi_error;

/// Compress data using Zstandard.
///
/// Returns the compressed data as a Buffer.
/// Level is an integer from 1 (fastest) to 22 (best compression). Default is
/// 3. Negative levels (-1 to -131072) enable fast mode, trading compression
/// ratio for speed. Level 0 is equivalent to the default level (3).
#[napi]
pub fn zstd_compress(data: Either<Buffer, Uint8Array>, level: Option<f64>) -> Result<Buffer> {
    let level = comprs_core::zstd::LEVEL
        .check_optional_f64(level)
        .map_err(to_napi_error)?;
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
) -> AsyncTask<Checked<ZstdCompressTask>> {
    checked(|| {
        let data = data.get()?;
        let level = comprs_core::zstd::LEVEL
            .check_optional_f64(level.get()?)
            .map_err(to_napi_error)?;
        Ok(ZstdCompressTask {
            data: crate::as_bytes(&data).to_vec(),
            level,
        })
    })
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
/// The input may hold several concatenated frames, including skippable
/// frames. The maximum decompressed size is 256 MB. Use
/// `zstdDecompressWithCapacity` for larger data.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array",
    ts_return_type = "Promise<Buffer>"
)]
pub fn zstd_decompress_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
) -> AsyncTask<Checked<ZstdDecompressTask>> {
    checked(|| {
        Ok(ZstdDecompressTask {
            data: crate::as_bytes(&data.get()?).to_vec(),
        })
    })
}

/// Decompress Zstandard-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The input may hold several concatenated frames, including skippable
/// frames. The maximum decompressed size is 256 MB. Use
/// `zstdDecompressWithCapacity` for larger data.
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
/// It is only a limit: the output buffer grows with the decompressed data, so
/// a large `capacity` reserves no memory up front.
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
/// `maxDictSize` is optional and defaults to 110 KB (the zstd default). It
/// must not exceed 16 MiB (16777216 bytes).
#[napi]
pub fn zstd_train_dictionary(
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

    comprs_core::zstd::train_dictionary(&sample_vecs, max_size)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Compress data using Zstandard with a pre-trained dictionary.
///
/// The same dictionary must be used for decompression via `zstdDecompressWithDict`.
/// Level is an integer from -131072 to 22, as for `zstdCompress`. Default is
/// 3.
#[napi]
pub fn zstd_compress_with_dict(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    level: Option<f64>,
) -> Result<Buffer> {
    let level = comprs_core::zstd::LEVEL
        .check_optional_f64(level)
        .map_err(to_napi_error)?;
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
/// It is only a limit: the output buffer grows with the decompressed data, so
/// a large `capacity` reserves no memory up front.
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
/// It is only a limit: the output buffer grows with the decompressed data, so
/// a large `capacity` reserves no memory up front.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, capacity: number",
    ts_return_type = "Promise<Buffer>"
)]
pub fn zstd_decompress_with_capacity_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    capacity: AsyncArg<f64>,
) -> AsyncTask<Checked<ZstdDecompressWithCapacityTask>> {
    checked(|| {
        let data = data.get()?;
        let cap = comprs_core::validate_capacity(capacity.get()?).map_err(to_napi_error)?;
        Ok(ZstdDecompressWithCapacityTask {
            data: crate::as_bytes(&data).to_vec(),
            capacity: cap,
        })
    })
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
) -> AsyncTask<Checked<ZstdCompressWithDictTask>> {
    checked(|| {
        let data = data.get()?;
        let dict = dict.get()?;
        let level = comprs_core::zstd::LEVEL
            .check_optional_f64(level.get()?)
            .map_err(to_napi_error)?;
        Ok(ZstdCompressWithDictTask {
            data: crate::as_bytes(&data).to_vec(),
            dict: crate::as_bytes(&dict).to_vec(),
            level,
        })
    })
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
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, dict: Buffer | Uint8Array",
    ts_return_type = "Promise<Buffer>"
)]
pub fn zstd_decompress_with_dict_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    dict: AsyncArg<Either<Buffer, Uint8Array>>,
) -> AsyncTask<Checked<ZstdDecompressWithDictTask>> {
    checked(|| {
        let data = data.get()?;
        let dict = dict.get()?;
        Ok(ZstdDecompressWithDictTask {
            data: crate::as_bytes(&data).to_vec(),
            dict: crate::as_bytes(&dict).to_vec(),
        })
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
/// `maxDictSize` is optional and defaults to 110 KB (the zstd default). It
/// must not exceed 16 MiB (16777216 bytes).
#[napi(
    ts_args_type = "samples: Array<Buffer | Uint8Array>, maxDictSize?: number | undefined | null",
    ts_return_type = "Promise<Buffer>"
)]
pub fn zstd_train_dictionary_async(
    samples: AsyncArg<Vec<Either<Buffer, Uint8Array>>>,
    max_dict_size: AsyncArg<Option<f64>>,
) -> AsyncTask<Checked<ZstdTrainDictionaryTask>> {
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
        Ok(ZstdTrainDictionaryTask {
            samples: sample_vecs,
            max_dict_size: max_size,
        })
    })
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
/// It is only a limit: the output buffer grows with the decompressed data, so
/// a large `capacity` reserves no memory up front.
/// The same dictionary used for compression must be provided.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, dict: Buffer | Uint8Array, capacity: number",
    ts_return_type = "Promise<Buffer>"
)]
pub fn zstd_decompress_with_dict_with_capacity_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    dict: AsyncArg<Either<Buffer, Uint8Array>>,
    capacity: AsyncArg<f64>,
) -> AsyncTask<Checked<ZstdDecompressWithDictWithCapacityTask>> {
    checked(|| {
        let data = data.get()?;
        let dict = dict.get()?;
        let cap = comprs_core::validate_capacity(capacity.get()?).map_err(to_napi_error)?;
        Ok(ZstdDecompressWithDictWithCapacityTask {
            data: crate::as_bytes(&data).to_vec(),
            dict: crate::as_bytes(&dict).to_vec(),
            capacity: cap,
        })
    })
}
