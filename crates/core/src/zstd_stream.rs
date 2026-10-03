//! Zstandard streaming compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::context::NativeState;
use crate::error::to_napi_error;

/// Streaming zstd compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked compression without losing cross-chunk context.
#[napi(custom_finalize)]
pub struct ZstdCompressContext {
    inner: NativeState<comprs_core::zstd_stream::CompressContext>,
}

#[napi]
impl ZstdCompressContext {
    #[napi(constructor)]
    pub fn new(env: Env, level: Option<f64>) -> Result<Self> {
        let level = comprs_core::zstd::LEVEL
            .check_optional_f64(level)
            .map_err(to_napi_error)?;
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::zstd_stream::CompressContext::new(level).map_err(to_napi_error)?,
                "zstd stream",
            ),
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the encoder is buffering data internally).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the encoder's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.flush())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Finalize the compression stream. Writes the zstd frame footer.
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

impl ObjectFinalize for ZstdCompressContext {
    fn finalize(mut self, env: Env) -> Result<()> {
        self.inner.close(&env);
        Ok(())
    }
}

/// Streaming zstd decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a zstd frame.
#[napi(custom_finalize)]
pub struct ZstdDecompressContext {
    inner: NativeState<comprs_core::zstd_stream::DecompressContext>,
}

#[napi]
impl ZstdDecompressContext {
    #[napi(constructor)]
    pub fn new(env: Env, max_output_size: Option<f64>) -> Result<Self> {
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::zstd_stream::DecompressContext::new(max_output_size)
                    .map_err(to_napi_error)?,
                "zstd stream",
            ),
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decoder needs more data).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the decoder's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.flush())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Finalize the decompression stream. Returns any remaining decompressed data.
    /// Throws if the input ended before the end of a zstd frame, including empty input.
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

impl ObjectFinalize for ZstdDecompressContext {
    fn finalize(mut self, env: Env) -> Result<()> {
        self.inner.close(&env);
        Ok(())
    }
}

/// Streaming zstd compression context with dictionary.
///
/// Maintains internal compression state across multiple `transform` calls,
/// using a pre-trained dictionary for improved compression of small, similar data.
#[napi(custom_finalize)]
pub struct ZstdCompressDictContext {
    inner: NativeState<comprs_core::zstd_stream::CompressDictContext>,
}

#[napi]
impl ZstdCompressDictContext {
    #[napi(constructor)]
    pub fn new(env: Env, dict: Either<Buffer, Uint8Array>, level: Option<f64>) -> Result<Self> {
        let level = comprs_core::zstd::LEVEL
            .check_optional_f64(level)
            .map_err(to_napi_error)?;
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::zstd_stream::CompressDictContext::new(crate::as_bytes(&dict), level)
                    .map_err(to_napi_error)?,
                "zstd stream",
            ),
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the encoder is buffering data internally).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the encoder's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.flush())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Finalize the compression stream. Writes the zstd frame footer.
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

impl ObjectFinalize for ZstdCompressDictContext {
    fn finalize(mut self, env: Env) -> Result<()> {
        self.inner.close(&env);
        Ok(())
    }
}

/// Streaming zstd decompression context with dictionary.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// using a pre-trained dictionary that matches the one used for compression.
#[napi(custom_finalize)]
pub struct ZstdDecompressDictContext {
    inner: NativeState<comprs_core::zstd_stream::DecompressDictContext>,
}

#[napi]
impl ZstdDecompressDictContext {
    #[napi(constructor)]
    pub fn new(
        env: Env,
        dict: Either<Buffer, Uint8Array>,
        max_output_size: Option<f64>,
    ) -> Result<Self> {
        Ok(Self {
            inner: NativeState::new(
                &env,
                comprs_core::zstd_stream::DecompressDictContext::new(
                    crate::as_bytes(&dict),
                    max_output_size,
                )
                .map_err(to_napi_error)?,
                "zstd stream",
            ),
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decoder needs more data).
    #[napi]
    pub fn transform(&mut self, env: Env, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.transform(crate::as_bytes(&chunk)))
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Flush the decoder's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<Buffer> {
        self.inner
            .run(&env, |ctx| ctx.flush())
            .map(|v| v.into())
            .map_err(to_napi_error)
    }

    /// Finalize the decompression stream. Returns any remaining decompressed data.
    /// Throws if the input ended before the end of a zstd frame, including empty input.
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

impl ObjectFinalize for ZstdDecompressDictContext {
    fn finalize(mut self, env: Env) -> Result<()> {
        self.inner.close(&env);
        Ok(())
    }
}
