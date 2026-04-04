//! Gzip and raw deflate compression and decompression.

use napi::Task;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::error::to_napi_error;

/// Compress data using gzip.
///
/// Returns the compressed data as a Buffer.
/// Level ranges from 0 (no compression) to 9 (best compression). Default is 6.
#[napi]
pub fn gzip_compress(data: Either<Buffer, Uint8Array>, level: Option<u32>) -> Result<Buffer> {
    comprs_core::gzip::compress(crate::as_bytes(&data), level)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Options for customizing the gzip header during compression.
#[napi(object)]
pub struct GzipHeaderOptions {
    /// Original filename to store in the gzip header.
    pub filename: Option<String>,
    /// Modification time as a Unix timestamp (seconds since epoch).
    pub mtime: Option<u32>,
}

/// Parsed gzip header metadata.
#[napi(object)]
pub struct GzipHeader {
    /// Original filename stored in the header, if present.
    pub filename: Option<String>,
    /// Modification time as a Unix timestamp (seconds since epoch).
    pub mtime: u32,
    /// Comment stored in the header, if present.
    pub comment: Option<String>,
    /// Operating system that created the gzip stream.
    pub os: u8,
    /// Extra field data, if present.
    pub extra: Option<Buffer>,
}

/// Compress data using gzip with custom header metadata.
///
/// Allows setting header fields such as `filename` and `mtime`.
/// Returns the compressed data as a Buffer.
/// Level ranges from 0 (no compression) to 9 (best compression). Default is 6.
#[napi]
pub fn gzip_compress_with_header(
    data: Either<Buffer, Uint8Array>,
    header: GzipHeaderOptions,
    level: Option<u32>,
) -> Result<Buffer> {
    let core_header = comprs_core::gzip::GzipHeaderOptions {
        filename: header.filename,
        mtime: header.mtime,
    };
    comprs_core::gzip::compress_with_header(crate::as_bytes(&data), &core_header, level)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Read gzip header metadata without fully decompressing the data.
///
/// Returns the parsed header fields including filename, mtime, comment, OS, and extra data.
#[napi]
pub fn gzip_read_header(data: Either<Buffer, Uint8Array>) -> Result<GzipHeader> {
    let h = comprs_core::gzip::read_header(crate::as_bytes(&data)).map_err(to_napi_error)?;
    Ok(GzipHeader {
        filename: h.filename,
        mtime: h.mtime,
        comment: h.comment,
        os: h.os,
        extra: h.extra.map(|b| b.into()),
    })
}

/// Decompress gzip-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `gzipDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn gzip_decompress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    comprs_core::gzip::decompress(crate::as_bytes(&data))
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Decompress gzip-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn gzip_decompress_with_capacity(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    comprs_core::gzip::decompress_with_capacity(crate::as_bytes(&data), cap)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Compress data using raw deflate (no gzip header/trailer).
///
/// Returns the compressed data as a Buffer.
/// Level ranges from 0 (no compression) to 9 (best compression). Default is 6.
#[napi]
pub fn deflate_compress(data: Either<Buffer, Uint8Array>, level: Option<u32>) -> Result<Buffer> {
    comprs_core::gzip::deflate_compress(crate::as_bytes(&data), level)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Decompress raw deflate-compressed data.
///
/// Returns the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `deflateDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn deflate_decompress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    comprs_core::gzip::deflate_decompress(crate::as_bytes(&data))
        .map(|v| v.into())
        .map_err(to_napi_error)
}

/// Decompress raw deflate-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn deflate_decompress_with_capacity(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<Buffer> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    comprs_core::gzip::deflate_decompress_with_capacity(crate::as_bytes(&data), cap)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

// --- Async tasks ---

pub struct GzipCompressTask {
    data: Vec<u8>,
    level: Option<u32>,
}

#[napi]
impl Task for GzipCompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::gzip::compress(&self.data, self.level).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously compress data using gzip.
///
/// Returns a Promise that resolves to the compressed data as a Buffer.
/// Level ranges from 0 (no compression) to 9 (best compression). Default is 6.
#[napi]
pub fn gzip_compress_async(
    data: Either<Buffer, Uint8Array>,
    level: Option<u32>,
) -> Result<AsyncTask<GzipCompressTask>> {
    // Validate level eagerly
    let lvl = level.unwrap_or(comprs_core::gzip::DEFAULT_LEVEL);
    if lvl > 9 {
        return Err(to_napi_error(comprs_core::ComprsError::InvalidArg(
            "gzip compression level must be between 0 and 9".to_string(),
        )));
    }
    let input = crate::as_bytes(&data).to_vec();
    Ok(AsyncTask::new(GzipCompressTask { data: input, level }))
}

pub struct GzipDecompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for GzipDecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::gzip::decompress(&self.data).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress gzip-compressed data.
///
/// Returns a Promise that resolves to the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `gzipDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn gzip_decompress_async(data: Either<Buffer, Uint8Array>) -> AsyncTask<GzipDecompressTask> {
    let input = crate::as_bytes(&data).to_vec();
    AsyncTask::new(GzipDecompressTask { data: input })
}

pub struct DeflateCompressTask {
    data: Vec<u8>,
    level: Option<u32>,
}

#[napi]
impl Task for DeflateCompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::gzip::deflate_compress(&self.data, self.level).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously compress data using raw deflate (no gzip header/trailer).
///
/// Returns a Promise that resolves to the compressed data as a Buffer.
/// Level ranges from 0 (no compression) to 9 (best compression). Default is 6.
#[napi]
pub fn deflate_compress_async(
    data: Either<Buffer, Uint8Array>,
    level: Option<u32>,
) -> Result<AsyncTask<DeflateCompressTask>> {
    let lvl = level.unwrap_or(comprs_core::gzip::DEFAULT_LEVEL);
    if lvl > 9 {
        return Err(to_napi_error(comprs_core::ComprsError::InvalidArg(
            "deflate compression level must be between 0 and 9".to_string(),
        )));
    }
    let input = crate::as_bytes(&data).to_vec();
    Ok(AsyncTask::new(DeflateCompressTask { data: input, level }))
}

pub struct DeflateDecompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for DeflateDecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::gzip::deflate_decompress(&self.data).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress raw deflate-compressed data.
///
/// Returns a Promise that resolves to the decompressed data as a Buffer.
/// The maximum decompressed size is 256 MB. Use `deflateDecompressWithCapacity`
/// for larger data.
#[napi]
pub fn deflate_decompress_async(
    data: Either<Buffer, Uint8Array>,
) -> AsyncTask<DeflateDecompressTask> {
    let input = crate::as_bytes(&data).to_vec();
    AsyncTask::new(DeflateDecompressTask { data: input })
}

pub struct GzipDecompressWithCapacityTask {
    data: Vec<u8>,
    capacity: usize,
}

#[napi]
impl Task for GzipDecompressWithCapacityTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::gzip::decompress_with_capacity(&self.data, self.capacity)
            .map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress gzip-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn gzip_decompress_with_capacity_async(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<AsyncTask<GzipDecompressWithCapacityTask>> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    let input = crate::as_bytes(&data).to_vec();
    Ok(AsyncTask::new(GzipDecompressWithCapacityTask {
        data: input,
        capacity: cap,
    }))
}

pub struct DeflateDecompressWithCapacityTask {
    data: Vec<u8>,
    capacity: usize,
}

#[napi]
impl Task for DeflateDecompressWithCapacityTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::gzip::deflate_decompress_with_capacity(&self.data, self.capacity)
            .map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress raw deflate-compressed data with explicit capacity.
///
/// Use this when the decompressed size exceeds the default 256 MB limit.
/// The `capacity` parameter specifies the maximum decompressed size in bytes.
#[napi]
pub fn deflate_decompress_with_capacity_async(
    data: Either<Buffer, Uint8Array>,
    capacity: f64,
) -> Result<AsyncTask<DeflateDecompressWithCapacityTask>> {
    let cap = comprs_core::validate_capacity(capacity).map_err(to_napi_error)?;
    let input = crate::as_bytes(&data).to_vec();
    Ok(AsyncTask::new(DeflateDecompressWithCapacityTask {
        data: input,
        capacity: cap,
    }))
}
