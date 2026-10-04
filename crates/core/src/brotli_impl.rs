//! Brotli compression and decompression.

use napi::Task;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::async_args::{AsyncArg, Checked, checked};
use crate::error::to_napi_error;

/// Compress data using Brotli.
///
/// Returns the compressed data as a Buffer.
/// Quality is an integer from 0 (fastest) to 11 (best compression). Default
/// is 6.
#[napi]
pub fn brotli_compress(data: Either<Buffer, Uint8Array>, quality: Option<f64>) -> Result<Buffer> {
    let quality = comprs_core::brotli::QUALITY
        .check_optional_f64(quality)
        .map_err(to_napi_error)?;
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
/// Quality is an integer from 0 (fastest) to 11 (best compression). Default
/// is 6.
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, quality?: number | undefined | null",
    ts_return_type = "Promise<Buffer>"
)]
pub fn brotli_compress_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    quality: AsyncArg<Option<f64>>,
) -> AsyncTask<Checked<BrotliCompressTask>> {
    checked(|| {
        let data = data.get()?;
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality.get()?)
            .map_err(to_napi_error)?;
        Ok(BrotliCompressTask {
            data: crate::as_bytes(&data).to_vec(),
            quality,
        })
    })
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
#[napi(
    ts_args_type = "data: Buffer | Uint8Array",
    ts_return_type = "Promise<Buffer>"
)]
pub fn brotli_decompress_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
) -> AsyncTask<Checked<BrotliDecompressTask>> {
    checked(|| {
        Ok(BrotliDecompressTask {
            data: crate::as_bytes(&data.get()?).to_vec(),
        })
    })
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
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, capacity: number",
    ts_return_type = "Promise<Buffer>"
)]
pub fn brotli_decompress_with_capacity_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    capacity: AsyncArg<f64>,
) -> AsyncTask<Checked<BrotliDecompressWithCapacityTask>> {
    checked(|| {
        let data = data.get()?;
        let cap = comprs_core::validate_capacity(capacity.get()?).map_err(to_napi_error)?;
        Ok(BrotliDecompressWithCapacityTask {
            data: crate::as_bytes(&data).to_vec(),
            capacity: cap,
        })
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
    data: Either<Buffer, Uint8Array>,
    dict: Either<Buffer, Uint8Array>,
    quality: Option<f64>,
) -> Result<Buffer> {
    let quality = comprs_core::brotli::QUALITY
        .check_optional_f64(quality)
        .map_err(to_napi_error)?;
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
) -> AsyncTask<Checked<BrotliCompressWithDictTask>> {
    checked(|| {
        let data = data.get()?;
        let dict = dict.get()?;
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality.get()?)
            .map_err(to_napi_error)?;
        Ok(BrotliCompressWithDictTask {
            data: crate::as_bytes(&data).to_vec(),
            dict: crate::as_bytes(&dict).to_vec(),
            quality,
        })
    })
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
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, dict: Buffer | Uint8Array",
    ts_return_type = "Promise<Buffer>"
)]
pub fn brotli_decompress_with_dict_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    dict: AsyncArg<Either<Buffer, Uint8Array>>,
) -> AsyncTask<Checked<BrotliDecompressWithDictTask>> {
    checked(|| {
        let data = data.get()?;
        let dict = dict.get()?;
        Ok(BrotliDecompressWithDictTask {
            data: crate::as_bytes(&data).to_vec(),
            dict: crate::as_bytes(&dict).to_vec(),
        })
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
#[napi(
    ts_args_type = "data: Buffer | Uint8Array, dict: Buffer | Uint8Array, capacity: number",
    ts_return_type = "Promise<Buffer>"
)]
pub fn brotli_decompress_with_dict_with_capacity_async(
    data: AsyncArg<Either<Buffer, Uint8Array>>,
    dict: AsyncArg<Either<Buffer, Uint8Array>>,
    capacity: AsyncArg<f64>,
) -> AsyncTask<Checked<BrotliDecompressWithDictWithCapacityTask>> {
    checked(|| {
        let data = data.get()?;
        let dict = dict.get()?;
        let cap = comprs_core::validate_capacity(capacity.get()?).map_err(to_napi_error)?;
        Ok(BrotliDecompressWithDictWithCapacityTask {
            data: crate::as_bytes(&data).to_vec(),
            dict: crate::as_bytes(&dict).to_vec(),
            capacity: cap,
        })
    })
}
