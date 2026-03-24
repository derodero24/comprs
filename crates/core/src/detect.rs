//! Unified auto-detect decompression API.
//!
//! Detects the compression format from magic bytes and decompresses accordingly.

use napi::Task;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::ComprsError;

/// Zstd magic number: 0xFD2FB528 (little-endian).
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

/// Gzip magic number: 0x1F 0x8B.
const GZIP_MAGIC: [u8; 2] = [0x1F, 0x8B];

/// LZ4 frame magic number: 0x184D2204.
const LZ4_MAGIC: [u8; 4] = [0x04, 0x22, 0x4D, 0x18];

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
    match detect(input) {
        Format::Zstd => CompressionFormat::Zstd,
        Format::Gzip => CompressionFormat::Gzip,
        Format::Brotli => CompressionFormat::Brotli,
        Format::Lz4 => CompressionFormat::Lz4,
        Format::Unknown => CompressionFormat::Unknown,
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
    let input = crate::as_bytes(&data);
    match detect(input) {
        Format::Zstd => crate::zstd_decompress(data),
        Format::Gzip => crate::gzip_decompress(data),
        Format::Brotli => crate::brotli_decompress(data),
        Format::Lz4 => crate::lz4_decompress(data),
        Format::Unknown => Err(ComprsError::InvalidArg(
            "unable to detect compression format; use algorithm-specific functions (zstdDecompress, gzipDecompress, brotliDecompress, lz4Decompress) instead".to_string(),
        )
        .into()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Format {
    Zstd,
    Gzip,
    Brotli,
    Lz4,
    Unknown,
}

impl std::fmt::Display for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Format::Zstd => write!(f, "zstd"),
            Format::Gzip => write!(f, "gzip"),
            Format::Brotli => write!(f, "brotli"),
            Format::Lz4 => write!(f, "lz4"),
            Format::Unknown => write!(f, "unknown"),
        }
    }
}

fn detect(data: &[u8]) -> Format {
    if data.len() >= 4 && data[..4] == ZSTD_MAGIC {
        return Format::Zstd;
    }
    if data.len() >= 2 && data[..2] == GZIP_MAGIC {
        return Format::Gzip;
    }
    if data.len() >= 4 && data[..4] == LZ4_MAGIC {
        return Format::Lz4;
    }
    // Brotli has no magic bytes. Attempt heuristic detection:
    // A valid brotli stream starts with a window size byte where the
    // lower nibble encodes WBITS. We try a quick decompression of the
    // first few bytes to see if brotli accepts it.
    if !data.is_empty() && is_likely_brotli(data) {
        return Format::Brotli;
    }
    Format::Unknown
}

/// Heuristic check for brotli data.
/// Attempts to decompress a small prefix to see if brotli accepts the header.
fn is_likely_brotli(data: &[u8]) -> bool {
    use std::io::Read;
    let mut decompressor = brotli::Decompressor::new(data, 4096);
    let mut buf = [0u8; 1];
    // If brotli can parse the header and produce output (or cleanly reach EOF),
    // it's likely a valid brotli stream.
    decompressor.read_exact(&mut buf).is_ok()
}

/// Maximum allowed decompressed size (256 MB) to prevent memory exhaustion.
const MAX_DECOMPRESSED_SIZE: usize = 256 * 1024 * 1024;

pub struct DecompressTask {
    data: Vec<u8>,
}

#[napi]
impl Task for DecompressTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        match detect(&self.data) {
            Format::Zstd => {
                let capacity = match zstd::zstd_safe::get_frame_content_size(&self.data) {
                    Ok(Some(size)) => (size as usize).min(MAX_DECOMPRESSED_SIZE),
                    _ => MAX_DECOMPRESSED_SIZE,
                };
                let capacity = capacity.max(1024);
                zstd::bulk::decompress(&self.data, capacity).map_err(|e| {
                    ComprsError::Operation {
                        context: "zstd decompress",
                        source: e.into(),
                    }
                    .into()
                })
            }
            Format::Gzip => {
                let decoder = flate2::read::MultiGzDecoder::new(self.data.as_slice());
                let init_cap = self.data.len().saturating_mul(4).min(MAX_DECOMPRESSED_SIZE);
                crate::decompress_with_limit(
                    decoder,
                    MAX_DECOMPRESSED_SIZE,
                    init_cap,
                    "gzip decompress",
                )
            }
            Format::Brotli => {
                let decompressor =
                    brotli::Decompressor::new(self.data.as_slice(), 4096);
                let init_cap = self.data.len().saturating_mul(4).min(MAX_DECOMPRESSED_SIZE);
                crate::decompress_with_limit(
                    decompressor,
                    MAX_DECOMPRESSED_SIZE,
                    init_cap,
                    "brotli decompress",
                )
            }
            Format::Lz4 => {
                let decoder = lz4_flex::frame::FrameDecoder::new(self.data.as_slice());
                let init_cap =
                    self.data.len().saturating_mul(4).min(MAX_DECOMPRESSED_SIZE);
                crate::decompress_with_limit(
                    decoder,
                    MAX_DECOMPRESSED_SIZE,
                    init_cap,
                    "lz4 decompress",
                )
            }
            Format::Unknown => Err(ComprsError::InvalidArg(
                "unable to detect compression format; use algorithm-specific functions (zstdDecompress, gzipDecompress, brotliDecompress, lz4Decompress) instead".to_string(),
            )
            .into()),
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn detect_zstd() {
        let data = zstd::bulk::compress(b"test data for zstd", 3).unwrap();
        assert_eq!(detect(&data), Format::Zstd);
    }

    #[test]
    fn detect_gzip() {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(b"test data for gzip").unwrap();
        let data = encoder.finish().unwrap();
        assert_eq!(detect(&data), Format::Gzip);
    }

    #[test]
    fn detect_brotli() {
        let mut output = Vec::new();
        {
            let mut compressor = brotli::CompressorWriter::new(&mut output, 4096, 6, 22);
            compressor.write_all(b"test data for brotli").unwrap();
        }
        assert_eq!(detect(&output), Format::Brotli);
    }

    #[test]
    fn detect_lz4() {
        let mut compressed = Vec::new();
        let mut encoder = lz4_flex::frame::FrameEncoder::new(&mut compressed);
        encoder.write_all(b"test data for lz4").unwrap();
        encoder.finish().unwrap();
        assert_eq!(detect(&compressed), Format::Lz4);
    }

    #[test]
    fn detect_unknown() {
        let data = b"this is not compressed data at all";
        assert_eq!(detect(data), Format::Unknown);
    }

    #[test]
    fn detect_empty() {
        assert_eq!(detect(b""), Format::Unknown);
    }

    #[test]
    fn detect_too_short() {
        assert_eq!(detect(&[0x00]), Format::Unknown);
    }
}
