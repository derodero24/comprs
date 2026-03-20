//! Unified auto-detect decompression API.
//!
//! Detects the compression format from magic bytes and decompresses accordingly.

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Zstd magic number: 0xFD2FB528 (little-endian).
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

/// Gzip magic number: 0x1F 0x8B.
const GZIP_MAGIC: [u8; 2] = [0x1F, 0x8B];

/// Detect the compression format of the given data.
///
/// Returns `"zstd"`, `"gzip"`, or `"brotli"`.
/// Returns `"unknown"` if the format cannot be determined.
///
/// Note: Brotli has no magic bytes, so it is detected by elimination.
/// Data that does not match zstd or gzip is reported as `"brotli"` only
/// if it appears to start with a valid brotli stream. Otherwise, `"unknown"`
/// is returned.
#[napi]
pub fn detect_format(data: Either<Buffer, Uint8Array>) -> String {
    let input = crate::as_bytes(&data);
    detect(input).to_string()
}

/// Decompress data by auto-detecting the compression format.
///
/// Detects the format from magic bytes and decompresses using the
/// appropriate algorithm. The maximum decompressed size is 256 MB
/// for all formats.
///
/// Supported formats: zstd, gzip, brotli.
/// Raw deflate is not supported (no magic bytes to distinguish it).
#[napi]
pub fn decompress(data: Either<Buffer, Uint8Array>) -> Result<Buffer> {
    let input = crate::as_bytes(&data);
    match detect(input) {
        Format::Zstd => crate::zstd_decompress(data),
        Format::Gzip => crate::gzip_decompress(data),
        Format::Brotli => crate::brotli_decompress(data),
        Format::Unknown => Err(Error::new(
            Status::InvalidArg,
            "unable to detect compression format; use algorithm-specific functions (zstdDecompress, gzipDecompress, brotliDecompress) instead",
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Format {
    Zstd,
    Gzip,
    Brotli,
    Unknown,
}

impl std::fmt::Display for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Format::Zstd => write!(f, "zstd"),
            Format::Gzip => write!(f, "gzip"),
            Format::Brotli => write!(f, "brotli"),
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
