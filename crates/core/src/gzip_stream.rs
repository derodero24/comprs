//! Gzip and raw deflate streaming compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::error::to_napi_error;

/// Streaming gzip compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked gzip compression without losing cross-chunk context.
#[napi]
pub struct GzipCompressContext {
    inner: comprs_core::gzip_stream::GzipCompressContext,
}

#[napi]
impl GzipCompressContext {
    #[napi(constructor)]
    pub fn new(level: Option<u32>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::gzip_stream::GzipCompressContext::new(level)
                .map_err(to_napi_error)?,
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the encoder is buffering data internally).
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

    /// Finalize the gzip stream. Writes the gzip footer (CRC32 + size).
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        self.inner.finish().map(|v| v.into()).map_err(to_napi_error)
    }
}

/// Streaming gzip decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a gzip stream.
#[napi]
pub struct GzipDecompressContext {
    inner: comprs_core::gzip_stream::GzipDecompressContext,
}

#[napi]
impl GzipDecompressContext {
    #[napi(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::gzip_stream::GzipDecompressContext::new(max_output_size)
                .map_err(to_napi_error)?,
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decoder needs more data).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .transform(crate::as_bytes(&chunk))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the decoder's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        self.inner.flush().map(|v| v.into()).map_err(to_napi_error)
    }

    /// Finalize the gzip decompression stream and verify CRC integrity.
    /// Must be called once after all compressed data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        self.inner.finish().map(|v| v.into()).map_err(to_napi_error)
    }
}

/// Streaming raw deflate compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked deflate compression without losing cross-chunk context.
#[napi]
pub struct DeflateCompressContext {
    inner: comprs_core::gzip_stream::DeflateCompressContext,
}

#[napi]
impl DeflateCompressContext {
    #[napi(constructor)]
    pub fn new(level: Option<u32>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::gzip_stream::DeflateCompressContext::new(level)
                .map_err(to_napi_error)?,
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the encoder is buffering data internally).
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

    /// Finalize the deflate stream.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        self.inner.finish().map(|v| v.into()).map_err(to_napi_error)
    }
}

/// Streaming raw deflate decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a raw deflate stream.
#[napi]
pub struct DeflateDecompressContext {
    inner: comprs_core::gzip_stream::DeflateDecompressContext,
}

#[napi]
impl DeflateDecompressContext {
    #[napi(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::gzip_stream::DeflateDecompressContext::new(max_output_size)
                .map_err(to_napi_error)?,
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decoder needs more data).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .transform(crate::as_bytes(&chunk))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the decoder's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        self.inner.flush().map(|v| v.into()).map_err(to_napi_error)
    }

    /// Finalize the deflate decompression stream.
    /// Must be called once after all compressed data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        self.inner.finish().map(|v| v.into()).map_err(to_napi_error)
    }
}
