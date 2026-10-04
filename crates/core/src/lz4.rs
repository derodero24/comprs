//! LZ4 frame compression and decompression.

use napi::Task;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::async_args::{AsyncArg, Checked, checked};
use crate::error::to_napi_error;

/// Compress data using LZ4 frame format.
///
/// Returns the compressed data as a Buffer. The frame carries a content
/// checksum, as the `lz4` CLI writes by default.
#[napi]
pub fn lz4_compress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    comprs_core::lz4::compress(crate::as_bytes(&data))
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Decompress LZ4 frame-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The input may hold several concatenated frames, including skippable and
/// legacy frames. The maximum decompressed size is 256 MB. Use
/// `lz4DecompressWithCapacity` for larger data.
#[napi]
pub fn lz4_decompress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    comprs_core::lz4::decompress(crate::as_bytes(&data))
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Decompress LZ4 frame-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn lz4_decompress_with_capacity(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    comprs_core::lz4::decompress_with_capacity(crate::as_bytes(&data), cap)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

// --- Async tasks ---

pub struct Lz4CompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for Lz4CompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::lz4::compress(&self.data).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

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
) -> AsyncTask<Checked<Lz4CompressTask>> {
    checked(|| {
        Ok(Lz4CompressTask {
            data: crate::as_bytes(&data.get()?).to_vec(),
        })
    })
}

pub struct Lz4DecompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for Lz4DecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::lz4::decompress(&self.data).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
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
) -> AsyncTask<Checked<Lz4DecompressTask>> {
    checked(|| {
        Ok(Lz4DecompressTask {
            data: crate::as_bytes(&data.get()?).to_vec(),
        })
    })
}

pub struct Lz4DecompressWithCapacityTask {
    data: Vec<u8>,
    capacity: usize,
}

#[napi]
impl Task for Lz4DecompressWithCapacityTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::lz4::decompress_with_capacity(&self.data, self.capacity).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
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
) -> AsyncTask<Checked<Lz4DecompressWithCapacityTask>> {
    checked(|| {
        let data = data.get()?;
        let cap = comprs_core::validate_capacity(capacity.get()?).map_err(to_napi_error)?;
        Ok(Lz4DecompressWithCapacityTask {
            data: crate::as_bytes(&data).to_vec(),
            capacity: cap,
        })
    })
}
