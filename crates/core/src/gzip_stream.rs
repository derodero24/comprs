//! Gzip and raw deflate streaming compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::context::{NativeState, stream_context_methods};
use crate::error::to_napi_error;

/// Streaming gzip compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked gzip compression without losing cross-chunk context.
#[napi(custom_finalize)]
pub struct GzipCompressContext {
    inner: NativeState<comprs_core::gzip_stream::GzipCompressContext>,
}

#[napi]
impl GzipCompressContext {
    #[napi(constructor)]
    pub fn new(env: Env, level: Option<f64>) -> Result<Self> {
        let level = comprs_core::gzip::LEVEL
            .check_optional_f64(level)
            .map_err(to_napi_error)?;
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::gzip_stream::GzipCompressContext::new(level).map_err(to_napi_error)?,
                "gzip stream",
            ),
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the encoder is buffering data internally).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .call(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
    }

    /// Flush the encoder's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call(&env, |ctx| ctx.flush())
    }

    /// Finalize the gzip stream. Writes the gzip footer (CRC32 + size).
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call_finish(&env, |ctx| ctx.finish())
    }
}

stream_context_methods!(
    GzipCompressContext,
    comprs_core::gzip_stream::GzipCompressContext
);

/// Streaming gzip decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a gzip stream.
#[napi(custom_finalize)]
pub struct GzipDecompressContext {
    inner: NativeState<comprs_core::gzip_stream::GzipDecompressContext>,
}

#[napi]
impl GzipDecompressContext {
    #[napi(constructor)]
    pub fn new(env: Env, max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::gzip_stream::GzipDecompressContext::new(max_output_size)
                    .map_err(to_napi_error)?,
                "gzip stream",
            ),
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decoder needs more data).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .call(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
    }

    /// Flush the decoder's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call(&env, |ctx| ctx.flush())
    }

    /// Finalize the gzip decompression stream and verify CRC integrity.
    /// Throws if the input is truncated, including empty input.
    /// Must be called once after all compressed data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call_finish(&env, |ctx| ctx.finish())
    }
}

stream_context_methods!(
    GzipDecompressContext,
    comprs_core::gzip_stream::GzipDecompressContext
);

/// Streaming raw deflate compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked deflate compression without losing cross-chunk context.
#[napi(custom_finalize)]
pub struct DeflateCompressContext {
    inner: NativeState<comprs_core::gzip_stream::DeflateCompressContext>,
}

#[napi]
impl DeflateCompressContext {
    #[napi(constructor)]
    pub fn new(env: Env, level: Option<f64>) -> Result<Self> {
        let level = comprs_core::gzip::DEFLATE_LEVEL
            .check_optional_f64(level)
            .map_err(to_napi_error)?;
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::gzip_stream::DeflateCompressContext::new(level)
                    .map_err(to_napi_error)?,
                "deflate stream",
            ),
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the encoder is buffering data internally).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .call(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
    }

    /// Flush the encoder's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call(&env, |ctx| ctx.flush())
    }

    /// Finalize the deflate stream.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call_finish(&env, |ctx| ctx.finish())
    }
}

stream_context_methods!(
    DeflateCompressContext,
    comprs_core::gzip_stream::DeflateCompressContext
);

/// Streaming raw deflate decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a raw deflate stream.
#[napi(custom_finalize)]
pub struct DeflateDecompressContext {
    inner: NativeState<comprs_core::gzip_stream::DeflateDecompressContext>,
}

#[napi]
impl DeflateDecompressContext {
    #[napi(constructor)]
    pub fn new(env: Env, max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::gzip_stream::DeflateDecompressContext::new(max_output_size)
                    .map_err(to_napi_error)?,
                "deflate stream",
            ),
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decoder needs more data).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .call(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
    }

    /// Flush the decoder's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call(&env, |ctx| ctx.flush())
    }

    /// Finalize the deflate decompression stream.
    /// Throws if the input ended before the final deflate block, including empty input.
    /// Must be called once after all compressed data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner.call_finish(&env, |ctx| ctx.finish())
    }
}

stream_context_methods!(
    DeflateDecompressContext,
    comprs_core::gzip_stream::DeflateDecompressContext
);
