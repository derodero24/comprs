//! LZ4 frame compression and decompression.

use std::io::Write;

use lz4_flex::frame::{FrameDecoder, FrameEncoder};

use crate::ComprsError;

/// Compress data using LZ4 frame format.
pub fn compress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    let mut output = Vec::with_capacity(data.len());
    let mut encoder = FrameEncoder::new(&mut output);
    encoder
        .write_all(data)
        .map_err(|e| ComprsError::Operation {
            context: "lz4 compress",
            source: e.into(),
        })?;
    encoder.finish().map_err(|e| ComprsError::Operation {
        context: "lz4 compress",
        source: e.into(),
    })?;

    Ok(output)
}

/// Decompress LZ4 frame-compressed data.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    let decoder = FrameDecoder::new(data);
    let init_cap = data
        .len()
        .saturating_mul(4)
        .min(crate::MAX_DECOMPRESSED_SIZE);
    crate::decompress_with_limit(
        decoder,
        crate::MAX_DECOMPRESSED_SIZE,
        init_cap,
        "lz4 decompress",
    )
}

/// Decompress LZ4 frame-compressed data with explicit capacity.
pub fn decompress_with_capacity(data: &[u8], capacity: usize) -> Result<Vec<u8>, ComprsError> {
    let decoder = FrameDecoder::new(data);
    let init_cap = data.len().saturating_mul(4).min(capacity);
    crate::decompress_with_limit(decoder, capacity, init_cap, "lz4 decompress")
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    #[test]
    fn round_trip_basic() {
        let original = b"Hello, comprs! This is a test of LZ4 compression.";
        let mut compressed = Vec::new();
        let mut encoder = FrameEncoder::new(&mut compressed);
        encoder.write_all(original).unwrap();
        encoder.finish().unwrap();

        let mut decoder = FrameDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn round_trip_empty() {
        let original = b"";
        let mut compressed = Vec::new();
        let mut encoder = FrameEncoder::new(&mut compressed);
        encoder.write_all(original).unwrap();
        encoder.finish().unwrap();

        let mut decoder = FrameDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn round_trip_large() {
        let original: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
        let mut compressed = Vec::new();
        let mut encoder = FrameEncoder::new(&mut compressed);
        encoder.write_all(&original).unwrap();
        encoder.finish().unwrap();

        let mut decoder = FrameDecoder::new(compressed.as_slice());
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original, decompressed);
        assert!(compressed.len() < original.len());
    }

    #[test]
    fn lz4_frame_magic_bytes() {
        let mut compressed = Vec::new();
        let mut encoder = FrameEncoder::new(&mut compressed);
        encoder.write_all(b"test").unwrap();
        encoder.finish().unwrap();

        assert!(compressed.len() >= 4);
        assert_eq!(&compressed[..4], &[0x04, 0x22, 0x4D, 0x18]);
    }

    #[test]
    fn compress_decompress_round_trip() {
        let original = b"Hello from core-lib lz4!";
        let compressed = compress(original).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
