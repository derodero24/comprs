//! Brotli compression and decompression.

use napi::Task;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::error::to_napi_error;

/// Compress data using Brotli.
///
/// Returns the compressed data as a Buffer.
/// Quality ranges from 0 (fastest) to 11 (best compression). Default is 6.
#[napi]
pub fn brotli_compress(data: Either<Buffer, Uint8Array>, quality: Option<u32>) -> Result<Buffer> {
    comprs_core::brotli::compress(crate::as_bytes(&data), quality)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Decompress Brotli-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB.
#[napi]
pub fn brotli_decompress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    comprs_core::brotli::decompress(crate::as_bytes(&data))
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Decompress Brotli-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn brotli_decompress_with_capacity(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    comprs_core::brotli::decompress_with_capacity(crate::as_bytes(&data), cap)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

// --- Async tasks ---

pub struct BrotliCompressTask {
    data: Vec<u8>,
    quality: Option<u32>,
}

#[napi]
impl Task for BrotliCompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::brotli::compress(&self.data, self.quality).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously compress data using Brotli.
///
/// Returns a Promise that resolves to the compressed data as a Buffer.
/// Quality ranges from 0 (fastest) to 11 (best compression). Default is 6.
#[napi]
pub fn brotli_compress_async(
    data: Either<Buffer, Uint8Array>,
    quality: Option<u32>,
) -> Result<AsyncTask<BrotliCompressTask>> {
    let q = quality.unwrap_or(comprs_core::brotli::DEFAULT_QUALITY);
    if q > 11 {
        return Err(to_napi_error(comprs_core::ComprsError::InvalidArg(
            "brotli quality must be between 0 and 11".to_string(),
        )));
    }
    let input = crate::as_bytes(&data).to_vec();
    Ok(AsyncTask::new(BrotliCompressTask {
        data: input,
        quality,
    }))
}

pub struct BrotliDecompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for BrotliDecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::brotli::decompress(&self.data).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress Brotli-compressed data.
///
/// Returns a Promise that resolves to the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB.
#[napi]
pub fn brotli_decompress_async(
    data: Either<Buffer, Uint8Array>,
) -> AsyncTask<BrotliDecompressTask> {
    let input = crate::as_bytes(&data).to_vec();
    AsyncTask::new(BrotliDecompressTask { data: input })
}

pub struct BrotliDecompressWithCapacityTask {
    data: Vec<u8>,
    capacity: usize,
}

#[napi]
impl Task for BrotliDecompressWithCapacityTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::brotli::decompress_with_capacity(&self.data, self.capacity)
            .map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress Brotli-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn brotli_decompress_with_capacity_async(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<AsyncTask<BrotliDecompressWithCapacityTask>> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    let input = crate::as_bytes(&data).to_vec();
    Ok(AsyncTask::new(BrotliDecompressWithCapacityTask {
        data: input,
        capacity: cap,
    }))
}

// --- Dictionary compression/decompression ---

/// Compress data using Brotli with a custom dictionary.
///
/// The same dictionary must be used for decompression via `brotliDecompressWithDict`.
/// Quality ranges from 0 (fastest) to 11 (best compression). Default is 6.
#[napi]
pub fn brotli_compress_with_dict(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    quality: Option<u32>,
) -> Result<Buffer> {
    comprs_core::brotli::compress_with_dict(crate::as_bytes(&data), crate::as_bytes(&dict), quality)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Decompress Brotli-compressed data that was compressed with a custom dictionary.
///
/// The same dictionary used for compression must be provided.
#[napi]
pub fn brotli_decompress_with_dict(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
) -> Result<Buffer> {
    comprs_core::brotli::decompress_with_dict(crate::as_bytes(&data), crate::as_bytes(&dict))
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Decompress Brotli-compressed data that was compressed with a custom dictionary,
/// with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
/// The same dictionary used for compression must be provided.
#[napi]
pub fn brotli_decompress_with_dict_with_capacity(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    comprs_core::brotli::decompress_with_dict_with_capacity(
        crate::as_bytes(&data),
        crate::as_bytes(&dict),
        cap,
    )
    .map(|v| v.into())
    .map_err(to_napi_error)
}

// --- Async tasks for dictionary compression ---

pub struct BrotliCompressWithDictTask {
    data: Vec<u8>,
    dict: Vec<u8>,
    quality: Option<u32>,
}

#[napi]
impl Task for BrotliCompressWithDictTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::brotli::compress_with_dict(&self.data, &self.dict, self.quality)
            .map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously compress data using Brotli with a custom dictionary.
///
/// The same dictionary must be used for decompression via `brotliDecompressWithDict`.
/// Quality ranges from 0 (fastest) to 11 (best compression). Default is 6.
#[napi]
pub fn brotli_compress_with_dict_async(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    quality: Option<u32>,
) -> Result<AsyncTask<BrotliCompressWithDictTask>> {
    let q = quality.unwrap_or(comprs_core::brotli::DEFAULT_QUALITY);
    if q > 11 {
        return Err(to_napi_error(comprs_core::ComprsError::InvalidArg(
            "brotli quality must be between 0 and 11".to_string(),
        )));
    }
    let input = crate::as_bytes(&data).to_vec();
    let dict_bytes = crate::as_bytes(&dict).to_vec();
    Ok(AsyncTask::new(BrotliCompressWithDictTask {
        data: input,
        dict: dict_bytes,
        quality,
    }))
}

pub struct BrotliDecompressWithDictTask {
    data: Vec<u8>,
    dict: Vec<u8>,
}

#[napi]
impl Task for BrotliDecompressWithDictTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::brotli::decompress_with_dict(&self.data, &self.dict).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress Brotli-compressed data that was compressed with a custom dictionary.
///
/// The same dictionary used for compression must be provided.
#[napi]
pub fn brotli_decompress_with_dict_async(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
) -> AsyncTask<BrotliDecompressWithDictTask> {
    let input = crate::as_bytes(&data).to_vec();
    let dict_bytes = crate::as_bytes(&dict).to_vec();
    AsyncTask::new(BrotliDecompressWithDictTask {
        data: input,
        dict: dict_bytes,
    })
}

pub struct BrotliDecompressWithDictWithCapacityTask {
    data: Vec<u8>,
    dict: Vec<u8>,
    capacity: usize,
}

#[napi]
impl Task for BrotliDecompressWithDictWithCapacityTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::brotli::decompress_with_dict_with_capacity(
            &self.data,
            &self.dict,
            self.capacity,
        )
        .map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress Brotli-compressed data that was compressed with a custom dictionary,
/// with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
/// The same dictionary used for compression must be provided.
#[napi]
pub fn brotli_decompress_with_dict_with_capacity_async(
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<AsyncTask<BrotliDecompressWithDictWithCapacityTask>> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    let input = crate::as_bytes(&data).to_vec();
    let dict_bytes = crate::as_bytes(&dict).to_vec();
    Ok(AsyncTask::new(BrotliDecompressWithDictWithCapacityTask {
        data: input,
        dict: dict_bytes,
        capacity: cap,
    }))
}
