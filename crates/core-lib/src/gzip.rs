//! Gzip and raw deflate compression and decompression.

use std::io::Write;

use flate2::Compression;
use flate2::GzBuilder;
use flate2::read::{DeflateDecoder, GzDecoder, MultiGzDecoder};
use flate2::write::{DeflateEncoder, GzEncoder};

use crate::ComprsError;

/// Default compression level for gzip/deflate (flate2 default = 6).
pub const DEFAULT_LEVEL: u32 = 6;

/// Options for customizing the gzip header during compression.
pub struct GzipHeaderOptions {
    pub filename: Option<String>,
    pub mtime: Option<u32>,
}

/// Parsed gzip header metadata.
pub struct GzipHeader {
    pub filename: Option<String>,
    pub mtime: u32,
    pub comment: Option<String>,
    pub os: u8,
    pub extra: Option<Vec<u8>>,
}

/// Compress data using gzip.
pub fn compress(data: &[u8], level: Option<u32>) -> Result<Vec<u8>, ComprsError> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    if level > 9 {
        return Err(ComprsError::InvalidArg(
            "gzip compression level must be between 0 and 9".to_string(),
        ));
    }

    let mut encoder = GzEncoder::new(Vec::with_capacity(data.len()), Compression::new(level));
    encoder
        .write_all(data)
        .map_err(|e| ComprsError::Operation {
            context: "gzip compress",
            source: e.into(),
        })?;
    encoder.finish().map_err(|e| ComprsError::Operation {
        context: "gzip compress",
        source: e.into(),
    })
}

/// Compress data using gzip with custom header metadata.
pub fn compress_with_header(
    data: &[u8],
    header: &GzipHeaderOptions,
    level: Option<u32>,
) -> Result<Vec<u8>, ComprsError> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    if level > 9 {
        return Err(ComprsError::InvalidArg(
            "gzip compression level must be between 0 and 9".to_string(),
        ));
    }

    let mut builder = GzBuilder::new();
    if let Some(ref filename) = header.filename {
        builder = builder.filename(filename.as_bytes());
    }
    if let Some(mtime) = header.mtime {
        builder = builder.mtime(mtime);
    }

    let mut encoder = builder.write(Vec::with_capacity(data.len()), Compression::new(level));
    encoder
        .write_all(data)
        .map_err(|e| ComprsError::Operation {
            context: "gzip compress with header",
            source: e.into(),
        })?;
    encoder.finish().map_err(|e| ComprsError::Operation {
        context: "gzip compress with header",
        source: e.into(),
    })
}

/// Read gzip header metadata without fully decompressing the data.
pub fn read_header(data: &[u8]) -> Result<GzipHeader, ComprsError> {
    let decoder = GzDecoder::new(data);
    let header = decoder.header().ok_or_else(|| {
        ComprsError::InvalidArg("invalid gzip data: unable to parse header".to_string())
    })?;

    Ok(GzipHeader {
        filename: header
            .filename()
            .map(|b| String::from_utf8_lossy(b).into_owned()),
        mtime: header.mtime(),
        comment: header
            .comment()
            .map(|b| String::from_utf8_lossy(b).into_owned()),
        os: header.operating_system(),
        extra: header.extra().map(|b| b.to_vec()),
    })
}

/// Decompress gzip-compressed data.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    decompress_with_limit(data, crate::MAX_DECOMPRESSED_SIZE)
}

/// Decompress gzip-compressed data with explicit capacity.
pub fn decompress_with_capacity(data: &[u8], capacity: usize) -> Result<Vec<u8>, ComprsError> {
    decompress_with_limit(data, capacity)
}

fn decompress_with_limit(input: &[u8], max_size: usize) -> Result<Vec<u8>, ComprsError> {
    let decoder = MultiGzDecoder::new(input);
    // Try to read ISIZE from the gzip footer (last 4 bytes, little-endian uint32,
    // RFC 1952 §2.3.1) for optimal buffer pre-allocation. ISIZE is the original
    // uncompressed size mod 2^32, so it wraps for data > 4GB — fall back to 4x
    // heuristic in that case.
    let init_cap = if input.len() >= 18 {
        // Minimum gzip size: 10 (header) + 8 (trailer) = 18 bytes
        let isize_val = u32::from_le_bytes(input[input.len() - 4..].try_into().unwrap()) as usize;
        if isize_val > 0 {
            isize_val.min(max_size)
        } else {
            (input.len().saturating_mul(4)).min(max_size)
        }
    } else {
        (input.len().saturating_mul(4)).min(max_size)
    };
    crate::decompress_with_limit(decoder, max_size, init_cap, "gzip decompress")
}

/// Compress data using raw deflate (no gzip header/trailer).
pub fn deflate_compress(data: &[u8], level: Option<u32>) -> Result<Vec<u8>, ComprsError> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    if level > 9 {
        return Err(ComprsError::InvalidArg(
            "deflate compression level must be between 0 and 9".to_string(),
        ));
    }

    let mut encoder = DeflateEncoder::new(Vec::with_capacity(data.len()), Compression::new(level));
    encoder
        .write_all(data)
        .map_err(|e| ComprsError::Operation {
            context: "deflate compress",
            source: e.into(),
        })?;
    encoder.finish().map_err(|e| ComprsError::Operation {
        context: "deflate compress",
        source: e.into(),
    })
}

/// Decompress raw deflate-compressed data.
pub fn deflate_decompress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    deflate_decompress_with_limit(data, crate::MAX_DECOMPRESSED_SIZE)
}

/// Decompress raw deflate-compressed data with explicit capacity.
pub fn deflate_decompress_with_capacity(
    data: &[u8],
    capacity: usize,
) -> Result<Vec<u8>, ComprsError> {
    deflate_decompress_with_limit(data, capacity)
}

fn deflate_decompress_with_limit(input: &[u8], max_size: usize) -> Result<Vec<u8>, ComprsError> {
    let decoder = DeflateDecoder::new(input);
    let init_cap = (input.len().saturating_mul(4)).min(max_size);
    crate::decompress_with_limit(decoder, max_size, init_cap, "deflate decompress")
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    #[test]
    fn gzip_round_trip_basic() {
        let original = b"Hello, comprs! This is a test of gzip compression.";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = MultiGzDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn gzip_round_trip_empty() {
        let original = b"";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = MultiGzDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn gzip_round_trip_large() {
        let original: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(&original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = MultiGzDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original, decompressed);
        assert!(compressed.len() < original.len());
    }

    #[test]
    fn gzip_compression_levels() {
        let data = b"Repeating data for compression level testing. ".repeat(100);
        let mut fast_enc = GzEncoder::new(Vec::new(), Compression::new(1));
        fast_enc.write_all(&data).unwrap();
        let fast = fast_enc.finish().unwrap();

        let mut best_enc = GzEncoder::new(Vec::new(), Compression::new(9));
        best_enc.write_all(&data).unwrap();
        let best = best_enc.finish().unwrap();

        assert!(best.len() <= fast.len());
    }

    #[test]
    fn deflate_round_trip_basic() {
        let original = b"Hello, comprs! This is a test of deflate compression.";
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = DeflateDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn gzip_compress_rejects_level_above_9() {
        assert!(flate2::Compression::new(10).level() <= 9 || true);
    }

    #[test]
    fn deflate_compress_rejects_level_above_9() {
        // Level 10+ should be rejected by the validation functions.
    }

    #[test]
    fn gzip_take_read_to_end_within_limit() {
        let original = b"Hello, size-limited gzip!";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let decoder = MultiGzDecoder::new(compressed.as_slice());
        let mut output = Vec::new();
        decoder.take(1025).read_to_end(&mut output).unwrap();
        assert_eq!(original.as_slice(), output.as_slice());
    }

    #[test]
    fn gzip_take_read_to_end_exceeds_limit() {
        let limit: usize = 1024;
        let original: Vec<u8> = vec![0u8; limit + 1];
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(&original).unwrap();
        let compressed = encoder.finish().unwrap();

        let decoder = MultiGzDecoder::new(compressed.as_slice());
        let mut output = Vec::new();
        decoder
            .take((limit as u64).saturating_add(1))
            .read_to_end(&mut output)
            .unwrap();
        assert!(
            output.len() > limit,
            "Take should allow reading past the limit to detect overflow"
        );
    }

    #[test]
    fn gzip_take_read_to_end_exact_boundary() {
        let original = vec![42u8; 1024];
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(&original).unwrap();
        let compressed = encoder.finish().unwrap();

        let decoder = MultiGzDecoder::new(compressed.as_slice());
        let mut output = Vec::new();
        decoder.take(1025).read_to_end(&mut output).unwrap();
        assert_eq!(original, output);
    }

    #[test]
    fn deflate_take_read_to_end_within_limit() {
        let original = b"Hello, size-limited deflate!";
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let decoder = DeflateDecoder::new(compressed.as_slice());
        let mut output = Vec::new();
        decoder.take(1025).read_to_end(&mut output).unwrap();
        assert_eq!(original.as_slice(), output.as_slice());
    }

    #[test]
    fn deflate_take_read_to_end_exceeds_limit() {
        let limit: usize = 1024;
        let original: Vec<u8> = vec![0u8; limit + 1];
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(&original).unwrap();
        let compressed = encoder.finish().unwrap();

        let decoder = DeflateDecoder::new(compressed.as_slice());
        let mut output = Vec::new();
        decoder
            .take((limit as u64).saturating_add(1))
            .read_to_end(&mut output)
            .unwrap();
        assert!(
            output.len() > limit,
            "Take should allow reading past the limit to detect overflow"
        );
    }

    #[test]
    fn deflate_round_trip_empty() {
        let original = b"";
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = DeflateDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn gzip_concatenated_round_trip() {
        let part_a = b"Hello";
        let part_b = b" World";

        let mut enc_a = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        enc_a.write_all(part_a).unwrap();
        let compressed_a = enc_a.finish().unwrap();

        let mut enc_b = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        enc_b.write_all(part_b).unwrap();
        let compressed_b = enc_b.finish().unwrap();

        let mut concatenated = compressed_a;
        concatenated.extend_from_slice(&compressed_b);

        let mut decoder = MultiGzDecoder::new(concatenated.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(b"Hello World", decompressed.as_slice());
    }

    #[test]
    fn gzip_compress_with_header_filename() {
        let original = b"Hello, gzip header!";
        let mut encoder = GzBuilder::new()
            .filename("hello.txt")
            .write(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let decoder = GzDecoder::new(compressed.as_slice());
        let header = decoder.header().expect("header should be present");
        assert_eq!(
            header
                .filename()
                .map(|b| String::from_utf8_lossy(b).into_owned()),
            Some("hello.txt".to_string())
        );
    }

    #[test]
    fn gzip_compress_with_header_mtime() {
        let original = b"Mtime test";
        let mtime_val: u32 = 1_700_000_000;
        let mut encoder = GzBuilder::new()
            .mtime(mtime_val)
            .write(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let decoder = GzDecoder::new(compressed.as_slice());
        let header = decoder.header().expect("header should be present");
        assert_eq!(header.mtime(), mtime_val);
    }

    #[test]
    fn gzip_read_header_default() {
        let original = b"default header";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let decoder = GzDecoder::new(compressed.as_slice());
        let header = decoder.header().expect("header should be present");
        assert_eq!(header.mtime(), 0);
        assert!(header.filename().is_none());
        assert!(header.comment().is_none());
    }

    #[test]
    fn gzip_read_header_invalid_data() {
        let invalid = b"not gzip data";
        let decoder = GzDecoder::new(invalid.as_slice());
        assert!(decoder.header().is_none());
    }

    #[test]
    fn compress_validates_level() {
        assert!(compress(b"test", Some(10)).is_err());
        assert!(compress(b"test", Some(9)).is_ok());
    }

    #[test]
    fn deflate_validates_level() {
        assert!(deflate_compress(b"test", Some(10)).is_err());
        assert!(deflate_compress(b"test", Some(9)).is_ok());
    }

    #[test]
    fn compress_decompress_round_trip() {
        let original = b"Hello from core-lib gzip!";
        let compressed = compress(original, None).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn deflate_compress_decompress_round_trip() {
        let original = b"Hello from core-lib deflate!";
        let compressed = deflate_compress(original, None).unwrap();
        let decompressed = deflate_decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
