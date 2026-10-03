//! Unified auto-detect decompression API.
//!
//! Detects the compression format from its magic number, or for brotli by
//! decoding the start of the data, and decompresses accordingly.

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
/// zstd, gzip and LZ4 are recognized by their magic numbers, LZ4 legacy
/// frames (`lz4 -l`) included. Skippable frames at the start of the data,
/// which zstd and LZ4 share, are skipped: the frame after them decides.
///
/// Brotli has no magic number, so it is detected heuristically: up to the
/// first 64 KiB of the data are decoded, and the data is reported as
/// `"brotli"` if they decode without error and either hold a whole brotli
/// stream that ends with the data, decode to more bytes than they hold, or
/// fill the 64 KiB. The start of a brotli stream of data that does not
/// compress is thus reported as `"unknown"` until it is 64 KiB long, and
/// about 5% of random data of 64 KiB or more is reported as `"brotli"`.
/// Raw deflate has no magic number and is not detected.
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
/// Detects the format like `detectFormat` and decompresses using the
/// appropriate algorithm.
///
/// `maxOutputSize` limits the decompressed size in bytes, like the
/// `maxOutputSize` of `createDecompressStream`. It defaults to 256 MB for all
/// formats. It is only a limit: a large value reserves no memory up front.
///
/// Supported formats: zstd, gzip, brotli, lz4.
/// Raw deflate is not supported (no magic bytes to distinguish it).
/// Data detected as brotli that does not decode as brotli throws the same
/// error as data of unknown format, since brotli detection is heuristic.
#[napi]
pub fn decompress(
    data: Either<Buffer, Uint8Array>,
    max_output_size: Option<f64>,
) -> Result<Buffer> {
    let max_size = comprs_core::validate_max_output_size(max_output_size).map_err(to_napi_error)?;
    comprs_core::detect::decompress_with_capacity(crate::as_bytes(&data), max_size)
        .map(|v| v.into())
        .map_err(to_napi_error)
}

pub struct DecompressTask {
    data: Vec<u8>,
    max_output_size: usize,
}

#[napi]
impl Task for DecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        comprs_core::detect::decompress_with_capacity(&self.data, self.max_output_size)
            .map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// Asynchronously decompress data by auto-detecting the compression format.
///
/// Detects the format like `detectFormat` and decompresses using the
/// appropriate algorithm. Returns a Promise that resolves to the
/// decompressed data as a Buffer.
///
/// `maxOutputSize` limits the decompressed size in bytes, as for
/// `decompress`. It defaults to 256 MB.
///
/// Supported formats: zstd, gzip, brotli, lz4.
/// Raw deflate is not supported (no magic bytes to distinguish it).
/// Data detected as brotli that does not decode as brotli rejects with the
/// same error as data of unknown format, since brotli detection is heuristic.
#[napi]
pub fn decompress_async(
    data: Either<Buffer, Uint8Array>,
    max_output_size: Option<f64>,
) -> Result<AsyncTask<DecompressTask>> {
    let max_size = comprs_core::validate_max_output_size(max_output_size).map_err(to_napi_error)?;
    let input = crate::as_bytes(&data).to_vec();
    Ok(AsyncTask::new(DecompressTask {
        data: input,
        max_output_size: max_size,
    }))
}
