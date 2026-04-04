//! Zstandard streaming compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::error::to_napi_error;

/// Streaming zstd compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked compression without losing cross-chunk context.
#[napi]
pub struct ZstdCompressContext {
    inner: comprs_core::zstd_stream::CompressContext,
}

#[napi]
impl ZstdCompressContext {
    #[napi(constructor)]
    pub fn new(level: Option<i32>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::zstd_stream::CompressContext::new(level).map_err(to_napi_error)?,
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

    /// Finalize the compression stream. Writes the zstd frame footer.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        self.inner.finish().map(|v| v.into()).map_err(to_napi_error)
    }
}

/// Streaming zstd decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a zstd frame.
#[napi]
pub struct ZstdDecompressContext {
    inner: comprs_core::zstd_stream::DecompressContext,
}

#[napi]
impl ZstdDecompressContext {
    #[napi(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::zstd_stream::DecompressContext::new(max_output_size)
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
}

/// Streaming zstd compression context with dictionary.
///
/// Maintains internal compression state across multiple `transform` calls,
/// using a pre-trained dictionary for improved compression of small, similar data.
#[napi]
pub struct ZstdCompressDictContext {
    inner: comprs_core::zstd_stream::CompressDictContext,
}

#[napi]
impl ZstdCompressDictContext {
    #[napi(constructor)]
    pub fn new(dict: Either<Buffer, Uint8Array>, level: Option<i32>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::zstd_stream::CompressDictContext::new(
                crate::as_bytes(&dict),
                level,
            )
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

    /// Finalize the compression stream. Writes the zstd frame footer.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        self.inner.finish().map(|v| v.into()).map_err(to_napi_error)
    }
}

/// Streaming zstd decompression context with dictionary.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// using a pre-trained dictionary that matches the one used for compression.
#[napi]
pub struct ZstdDecompressDictContext {
    inner: comprs_core::zstd_stream::DecompressDictContext,
}

#[napi]
impl ZstdDecompressDictContext {
    #[napi(constructor)]
    pub fn new(dict: Either<Buffer, Uint8Array>, max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::zstd_stream::DecompressDictContext::new(
                crate::as_bytes(&dict),
                max_output_size,
            )
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
}
