//! Brotli streaming compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::context::NativeState;
use crate::error::to_napi_error;

/// Streaming brotli compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked compression without losing cross-chunk context.
#[napi(custom_finalize)]
pub struct BrotliCompressContext {
    inner: NativeState<comprs_core::brotli_stream::CompressContext>,
}

#[napi]
impl BrotliCompressContext {
    #[napi(constructor)]
    pub fn new(env: Env, quality: Option<f64>) -> Result<Self> {
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality)
            .map_err(to_napi_error)?;
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::brotli_stream::CompressContext::new(quality).map_err(to_napi_error)?,
                "brotli stream",
            ),
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the compressor is buffering data internally).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the compressor's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.flush())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Finalize the compression stream. Writes the brotli stream footer.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .finish(&env, |ctx| ctx.finish())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Release the native state of the context now rather than when the
    /// context is garbage-collected. Later calls throw, and `finish()`
    /// releases the state too. Closing a finished or closed context does
    /// nothing. `[Symbol.dispose]()` is the same method, for `using`
    /// declarations.
    #[napi]
    pub fn close(&mut self, env: Env) {
        self.inner.close(&env);
    }
}

impl ObjectFinalize for BrotliCompressContext {
    fn finalize(mut self, env: Env) -> Result<()> {
        self.inner.close(&env);
        Ok(())
    }
}

/// Streaming brotli decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a brotli stream.
#[napi(custom_finalize)]
pub struct BrotliDecompressContext {
    inner: NativeState<comprs_core::brotli_stream::DecompressContext>,
}

#[napi]
impl BrotliDecompressContext {
    #[napi(constructor)]
    pub fn new(env: Env, max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::brotli_stream::DecompressContext::new(max_output_size)
                    .map_err(to_napi_error)?,
                "brotli stream",
            ),
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decompressor needs more data).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the decompressor's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.flush())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Finalize the decompression stream. Returns any remaining decompressed data.
    /// Throws if the input ended before the end of the brotli stream, including empty input.
    /// Must be called once after all compressed data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .finish(&env, |ctx| ctx.finish())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Release the native state of the context now rather than when the
    /// context is garbage-collected. Later calls throw, and `finish()`
    /// releases the state too. Closing a finished or closed context does
    /// nothing. `[Symbol.dispose]()` is the same method, for `using`
    /// declarations.
    #[napi]
    pub fn close(&mut self, env: Env) {
        self.inner.close(&env);
    }
}

impl ObjectFinalize for BrotliDecompressContext {
    fn finalize(mut self, env: Env) -> Result<()> {
        self.inner.close(&env);
        Ok(())
    }
}

/// Streaming brotli compression context with custom dictionary.
///
/// Buffers all input and compresses with the dictionary on `finish`.
/// This is necessary because the brotli CompressorWriter does not expose
/// a dictionary API; dictionary compression requires the low-level encoder.
#[napi(custom_finalize)]
pub struct BrotliCompressDictContext {
    inner: NativeState<comprs_core::brotli_stream::CompressDictContext>,
}

#[napi]
impl BrotliCompressDictContext {
    #[napi(constructor)]
    pub fn new(env: Env, dict: Either<Buffer, Uint8Array>, quality: Option<f64>) -> Result<Self> {
        let quality = comprs_core::brotli::QUALITY
            .check_optional_f64(quality)
            .map_err(to_napi_error)?;
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::brotli_stream::CompressDictContext::new(
                    crate::as_bytes(&dict),
                    quality,
                )
                .map_err(to_napi_error)?,
                "brotli dict stream",
            ),
        })
    }

    /// Buffer a chunk of data for compression. Returns an empty Buffer because
    /// all compression is deferred to `finish` (dictionary requires one-shot).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush returns empty Buffer because all data is buffered until finish.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.flush())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Finalize the compression. Compresses all buffered data with the dictionary.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .finish(&env, |ctx| ctx.finish())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Release the native state of the context now rather than when the
    /// context is garbage-collected. Later calls throw, and `finish()`
    /// releases the state too. Closing a finished or closed context does
    /// nothing. `[Symbol.dispose]()` is the same method, for `using`
    /// declarations.
    #[napi]
    pub fn close(&mut self, env: Env) {
        self.inner.close(&env);
    }
}

impl ObjectFinalize for BrotliCompressDictContext {
    fn finalize(mut self, env: Env) -> Result<()> {
        self.inner.close(&env);
        Ok(())
    }
}

/// Streaming brotli decompression context with custom dictionary.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// using a custom dictionary that matches the one used for compression.
#[napi(custom_finalize)]
pub struct BrotliDecompressDictContext {
    inner: NativeState<comprs_core::brotli_stream::DecompressDictContext>,
}

#[napi]
impl BrotliDecompressDictContext {
    #[napi(constructor)]
    pub fn new(
        env: Env,
        dict: Either<Buffer, Uint8Array>,
        max_output_size: Option<f64>,
    ) -> Result<Self> {
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::brotli_stream::DecompressDictContext::new(
                    crate::as_bytes(&dict),
                    max_output_size,
                )
                .map_err(to_napi_error)?,
                "brotli dict stream",
            ),
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decompressor needs more data).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the decompressor's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.flush())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Finalize the decompression stream. Returns any remaining decompressed data.
    /// Throws if the input ended before the end of the brotli stream, including empty input.
    /// Must be called once after all compressed data has been transformed.
    #[napi]
    pub fn finish(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .finish(&env, |ctx| ctx.finish())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Release the native state of the context now rather than when the
    /// context is garbage-collected. Later calls throw, and `finish()`
    /// releases the state too. Closing a finished or closed context does
    /// nothing. `[Symbol.dispose]()` is the same method, for `using`
    /// declarations.
    #[napi]
    pub fn close(&mut self, env: Env) {
        self.inner.close(&env);
    }
}

impl ObjectFinalize for BrotliDecompressDictContext {
    fn finalize(mut self, env: Env) -> Result<()> {
        self.inner.close(&env);
        Ok(())
    }
}
