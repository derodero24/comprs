//! Brotli streaming compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::error::to_napi_error;

/// Streaming brotli compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked compression without losing cross-chunk context.
#[napi]
pub struct BrotliCompressContext {
    inner: comprs_core::brotli_stream::CompressContext,
}

#[napi]
impl BrotliCompressContext {
    #[napi(constructor)]
    pub fn new(quality: Option<u32>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::brotli_stream::CompressContext::new(quality)
                .map_err(to_napi_error)?,
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the compressor is buffering data internally).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .transform(crate::as_bytes(&chunk))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the compressor's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        self.inner.flush().map(|v| v.into()).map_err(to_napi_error)
    }

    /// Finalize the compression stream. Writes the brotli stream footer.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        self.inner.finish().map(|v| v.into()).map_err(to_napi_error)
    }
}

/// Streaming brotli decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a brotli stream.
#[napi]
pub struct BrotliDecompressContext {
    inner: comprs_core::brotli_stream::DecompressContext,
}

#[napi]
impl BrotliDecompressContext {
    #[napi(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::brotli_stream::DecompressContext::new(max_output_size)
                .map_err(to_napi_error)?,
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decompressor needs more data).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .transform(crate::as_bytes(&chunk))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the decompressor's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        self.inner.flush().map(|v| v.into()).map_err(to_napi_error)
    }
}

/// Streaming brotli compression context with custom dictionary.
///
/// Buffers all input and compresses with the dictionary on `finish`.
/// This is necessary because the brotli CompressorWriter does not expose
/// a dictionary API; dictionary compression requires the low-level encoder.
#[napi]
pub struct BrotliCompressDictContext {
    inner: comprs_core::brotli_stream::CompressDictContext,
}

#[napi]
impl BrotliCompressDictContext {
    #[napi(constructor)]
    pub fn new(dict: Either<Buffer, Uint8Array>, quality: Option<u32>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::brotli_stream::CompressDictContext::new(
                crate::as_bytes(&dict),
                quality,
            )
            .map_err(to_napi_error)?,
        })
    }

    /// Buffer a chunk of data for compression. Returns an empty Buffer because
    /// all compression is deferred to `finish` (dictionary requires one-shot).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .transform(crate::as_bytes(&chunk))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush returns empty Buffer because all data is buffered until finish.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        self.inner.flush().map(|v| v.into()).map_err(to_napi_error)
    }

    /// Finalize the compression. Compresses all buffered data with the dictionary.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        self.inner.finish().map(|v| v.into()).map_err(to_napi_error)
    }
}

/// Streaming brotli decompression context with custom dictionary.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// using a custom dictionary that matches the one used for compression.
#[napi]
pub struct BrotliDecompressDictContext {
    inner: comprs_core::brotli_stream::DecompressDictContext,
}

#[napi]
impl BrotliDecompressDictContext {
    #[napi(constructor)]
    pub fn new(dict: Either<Buffer, Uint8Array>, max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: comprs_core::brotli_stream::DecompressDictContext::new(
                crate::as_bytes(&dict),
                max_output_size,
            )
            .map_err(to_napi_error)?,
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decompressor needs more data).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .transform(crate::as_bytes(&chunk))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the decompressor's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        self.inner.flush().map(|v| v.into()).map_err(to_napi_error)
    }
}
