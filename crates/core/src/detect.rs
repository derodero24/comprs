//! Unified auto-detect decompression API.
//!
//! Detects the compression format from magic bytes and decompresses accordingly.

use napi::Task;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::error::to_napi_error;

/// Compression format detected from input data.
#[napi(string_enum)]
pub enum CompressionFormat {
    #[napi(value = "zstd")]
    Zstd,
    #[napi(value = "gzip")]
    Gzip,
    #[napi(value = "brotli")]
    Brotli,
    #[napi(value = "lz4")]
    Lz4,
    #[napi(value = "unknown")]
    Unknown,
}

/// Detect the compression format of the given data.
///
/// Returns `"zstd"`, `"gzip"`, `"brotli"`, or `"lz4"`.
/// Returns `"unknown"` if the format cannot be determined.
///
/// Note: Brotli has no magic bytes, so it is detected by elimination.
/// Data that does not match zstd, gzip, or lz4 is reported as `"brotli"` only
/// if it appears to start with a valid brotli stream. Otherwise, `"unknown"`
/// is returned.
#[napi]
pub fn detect_format(data: Either<Buffer, Uint8Array>) -> CompressionFormat {
    let input = crate::as_bytes(&data);
    match comprs_core::detect::detect(input) {
        comprs_core::detect::Format::Zstd => CompressionFormat::Zstd,
        comprs_core::detect::Format::Gzip => CompressionFormat::Gzip,
        comprs_core::detect::Format::Brotli => CompressionFormat::Brotli,
        comprs_core::detect::Format::Lz4 => CompressionFormat::Lz4,
        comprs_core::detect::Format::Unknown => CompressionFormat::Unknown,
    }
}

/// Decompress data by auto-detecting the compression format.
///
/// Detects the format from magic bytes and decompresses using the
/// appropriate algorithm. The maximum decompressed size is 256 MB
/// for all formats.
///
/// Supported formats: zstd, gzip, brotli, lz4.
/// Raw deflate is not supported (no magic bytes to distinguish it).
#[napi]
pub fn decompress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    comprs_core::detect::decompress(crate::as_bytes(&data))
        .map(|v| v.into())
        .map_err(to_napi_error)
}

pub struct DecompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for DecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::detect::decompress(&self.data).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress data by auto-detecting the compression format.
///
/// Detects the format from magic bytes and decompresses using the
/// appropriate algorithm. Returns a Promise that resolves to the
/// decompressed data as a Buffer.
///
/// Supported formats: zstd, gzip, brotli, lz4.
/// Raw deflate is not supported (no magic bytes to distinguish it).
#[napi]
pub fn decompress_async(data: Either<Buffer, Uint8Array>) -> AsyncTask<DecompressTask> {
    let input = crate::as_bytes(&data).to_vec();
    AsyncTask::new(DecompressTask { data: input })
}
