//! LZ4 frame streaming compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::error::to_napi_error;

/// Streaming LZ4 frame compression context.
///
/// Uses `FrameEncoder` internally to produce incremental compressed output
/// on each `transform()` call. A cursor tracks already-returned bytes, and
/// old bytes are drained periodically to bound memory usage.
#[napi]
pub struct Lz4CompressContext {
    inner: comprs_core::lz4_stream::CompressContext,
}

#[napi]
impl Lz4CompressContext {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        Ok(Self {
            inner: comprs_core::lz4_stream::CompressContext::new().map_err(to_napi_error)?,
        })
    }

    /// Compress a chunk of data. Returns any compressed output produced so far.
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .transform(crate::as_bytes(&chunk))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the encoder's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        self.inner.flush().map(|v| v.into()).map_err(to_napi_error)
    }

    /// Finalize the compression stream. Writes the LZ4 frame footer.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        self.inner.finish().map(|v| v.into()).map_err(to_napi_error)
    }
}

/// Streaming LZ4 frame decompression context.
///
/// Buffers compressed input and decompresses on `flush()`.
/// LZ4 frame decompression requires the full compressed input, so true
/// incremental streaming is not possible with the current lz4_flex API.
#[napi]
pub struct Lz4DecompressContext {
    inner: comprs_core::lz4_stream::DecompressContext,
}

#[napi]
impl Lz4DecompressContext {
    #[napi(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::lz4_stream::DecompressContext::new(max_output_size)
                .map_err(to_napi_error)?,
        })
    }

    /// Buffer a chunk of compressed data.
    /// Returns an empty buffer (decompressed output is produced in `flush()`).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .transform(crate::as_bytes(&chunk))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Decompress all buffered data and return the result.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        self.inner.flush().map(|v| v.into()).map_err(to_napi_error)
    }
}
