//! Gzip and raw deflate compression and decompression.

use std::io::{Read, Write};

use flate2::Compression;
use flate2::read::{DeflateDecoder, GzDecoder};
use flate2::write::{DeflateEncoder, GzEncoder};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Default compression level for gzip/deflate (flate2 default = 6).
const DEFAULT_LEVEL: u32 = 6;

/// Compress data using gzip.
///
/// Returns the compressed data as a Buffer.
/// Level ranges from 0 (no compression) to 9 (best compression). Default is 6.
#[napi]
pub fn gzip_compress(data: Buffer, level: Option<u32>) -> Result<Buffer> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    let input = data.as_ref();

    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(level));
    encoder
        .write_all(input)
        .map_err(|e| Error::new(Status::GenericFailure, format!("gzip compress failed: {e}")))?;
    encoder
        .finish()
        .map(|v| v.into())
        .map_err(|e| Error::new(Status::GenericFailure, format!("gzip compress failed: {e}")))
}

/// Decompress gzip-compressed data.
///
/// Returns the decompressed data as a Buffer.
#[napi]
pub fn gzip_decompress(data: Buffer) -> Result<Buffer> {
    let input = data.as_ref();
    let mut decoder = GzDecoder::new(input);
    let mut output = Vec::new();

    decoder.read_to_end(&mut output).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("gzip decompress failed: {e}"),
        )
    })?;

    Ok(output.into())
}

/// Compress data using raw deflate (no gzip header/trailer).
///
/// Returns the compressed data as a Buffer.
/// Level ranges from 0 (no compression) to 9 (best compression). Default is 6.
#[napi]
pub fn deflate_compress(data: Buffer, level: Option<u32>) -> Result<Buffer> {
    let level = level.unwrap_or(DEFAULT_LEVEL);
    let input = data.as_ref();

    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(level));
    encoder.write_all(input).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("deflate compress failed: {e}"),
        )
    })?;
    encoder.finish().map(|v| v.into()).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("deflate compress failed: {e}"),
        )
    })
}

/// Decompress raw deflate-compressed data.
///
/// Returns the decompressed data as a Buffer.
#[napi]
pub fn deflate_decompress(data: Buffer) -> Result<Buffer> {
    let input = data.as_ref();
    let mut decoder = DeflateDecoder::new(input);
    let mut output = Vec::new();

    decoder.read_to_end(&mut output).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("deflate decompress failed: {e}"),
        )
    })?;

    Ok(output.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gzip_round_trip_basic() {
        let original = b"Hello, zflate! This is a test of gzip compression.";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = GzDecoder::new(compressed.as_slice());
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

        let mut decoder = GzDecoder::new(compressed.as_slice());
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

        let mut decoder = GzDecoder::new(compressed.as_slice());
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
        let original = b"Hello, zflate! This is a test of deflate compression.";
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = DeflateDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn deflate_round_trip_empty() {
        let original = b"";
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(DEFAULT_LEVEL));
        encoder.write_all(original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = DeflateDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
