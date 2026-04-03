//! Brotli compression and decompression.

use std::io::Write;

use crate::ComprsError;

/// Default compression quality for brotli.
pub const DEFAULT_QUALITY: u32 = 6;

/// Default buffer size for brotli operations.
pub const BUFFER_SIZE: usize = 4096;

/// Default log2 of the sliding window size for brotli.
pub const LG_WINDOW_SIZE: u32 = 22;

/// Compress data using Brotli.
pub fn compress(data: &[u8], quality: Option<u32>) -> Result<Vec<u8>, ComprsError> {
    let quality = quality.unwrap_or(DEFAULT_QUALITY);
    if quality > 11 {
        return Err(ComprsError::InvalidArg(
            "brotli quality must be between 0 and 11".to_string(),
        ));
    }

    let mut output = Vec::with_capacity(data.len());
    {
        let mut compressor =
            brotli::CompressorWriter::new(&mut output, BUFFER_SIZE, quality, LG_WINDOW_SIZE);
        compressor
            .write_all(data)
            .map_err(|e| ComprsError::Operation {
                context: "brotli compress",
                source: e.into(),
            })?;
        // Drop compressor to flush and finalize
    }

    Ok(output)
}

/// Decompress Brotli-compressed data.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    let decompressor = brotli::Decompressor::new(data, BUFFER_SIZE);
    let init_cap = (data.len().saturating_mul(4)).min(crate::MAX_DECOMPRESSED_SIZE);
    crate::decompress_with_limit(
        decompressor,
        crate::MAX_DECOMPRESSED_SIZE,
        init_cap,
        "brotli decompress",
    )
}

/// Decompress Brotli-compressed data with explicit capacity.
pub fn decompress_with_capacity(data: &[u8], capacity: usize) -> Result<Vec<u8>, ComprsError> {
    let decompressor = brotli::Decompressor::new(data, BUFFER_SIZE);
    let init_cap = (data.len().saturating_mul(4)).min(capacity);
    crate::decompress_with_limit(decompressor, capacity, init_cap, "brotli decompress")
}

/// Compress data with a custom dictionary using the brotli crate's low-level API.
pub fn compress_with_dict(
    input: &[u8],
    dict: &[u8],
    quality: Option<u32>,
) -> Result<Vec<u8>, ComprsError> {
    let quality = quality.unwrap_or(DEFAULT_QUALITY);
    if quality > 11 {
        return Err(ComprsError::InvalidArg(
            "brotli quality must be between 0 and 11".to_string(),
        ));
    }

    compress_with_dict_inner(input, dict, quality).map_err(|e| ComprsError::Operation {
        context: "brotli compress with dict",
        source: e.into(),
    })
}

/// Low-level dictionary compression implementation.
pub fn compress_with_dict_inner(
    input: &[u8],
    dict: &[u8],
    quality: u32,
) -> std::result::Result<Vec<u8>, std::io::Error> {
    use std::io::Cursor;

    let params = brotli::enc::BrotliEncoderParams {
        quality: quality as i32,
        lgwin: LG_WINDOW_SIZE as i32,
        ..Default::default()
    };

    let mut r = Cursor::new(input);
    let mut output = Vec::with_capacity(input.len());
    let mut input_buffer = [0u8; BUFFER_SIZE];
    let mut output_buffer = [0u8; BUFFER_SIZE];
    let alloc = brotli::enc::StandardAlloc::default();
    let mut nop =
        |_: &mut brotli::interface::PredictionModeContextMap<brotli::InputReferenceMut>,
         _: &mut [brotli::interface::StaticCommand],
         _: brotli::InputPair,
         _: &mut brotli::enc::StandardAlloc| {};

    brotli::BrotliCompressCustomIoCustomDict(
        &mut brotli::IoReaderWrapper(&mut r),
        &mut brotli::IoWriterWrapper(&mut output),
        &mut input_buffer[..],
        &mut output_buffer[..],
        &params,
        alloc,
        &mut nop,
        dict,
        std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "unexpected eof"),
    )?;
    Ok(output)
}

/// Decompress Brotli-compressed data that was compressed with a custom dictionary.
pub fn decompress_with_dict(data: &[u8], dict: &[u8]) -> Result<Vec<u8>, ComprsError> {
    let dict_bytes = dict.to_vec();
    let decompressor =
        brotli::Decompressor::new_with_custom_dict(data, BUFFER_SIZE, dict_bytes.into());
    let init_cap = (data.len().saturating_mul(4)).min(crate::MAX_DECOMPRESSED_SIZE);
    crate::decompress_with_limit(
        decompressor,
        crate::MAX_DECOMPRESSED_SIZE,
        init_cap,
        "brotli decompress with dict",
    )
}

/// Decompress Brotli-compressed data with a custom dictionary and explicit capacity.
pub fn decompress_with_dict_with_capacity(
    data: &[u8],
    dict: &[u8],
    capacity: usize,
) -> Result<Vec<u8>, ComprsError> {
    let dict_bytes = dict.to_vec();
    let decompressor =
        brotli::Decompressor::new_with_custom_dict(data, BUFFER_SIZE, dict_bytes.into());
    let init_cap = (data.len().saturating_mul(4)).min(capacity);
    crate::decompress_with_limit(
        decompressor,
        capacity,
        init_cap,
        "brotli decompress with dict",
    )
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use super::*;

    #[test]
    fn round_trip_basic() {
        let original = b"Hello, comprs! This is a test of brotli compression.";
        let mut compressed = Vec::new();
        {
            let mut compressor = brotli::CompressorWriter::new(
                &mut compressed,
                BUFFER_SIZE,
                DEFAULT_QUALITY,
                LG_WINDOW_SIZE,
            );
            compressor.write_all(original).unwrap();
        }
        let mut decompressor = brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE);
        let mut decompressed = Vec::new();
        decompressor.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn round_trip_empty() {
        let original = b"";
        let mut compressed = Vec::new();
        {
            let mut compressor = brotli::CompressorWriter::new(
                &mut compressed,
                BUFFER_SIZE,
                DEFAULT_QUALITY,
                LG_WINDOW_SIZE,
            );
            compressor.write_all(original).unwrap();
        }
        let mut decompressor = brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE);
        let mut decompressed = Vec::new();
        decompressor.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn round_trip_large() {
        let original: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
        let mut compressed = Vec::new();
        {
            let mut compressor = brotli::CompressorWriter::new(
                &mut compressed,
                BUFFER_SIZE,
                DEFAULT_QUALITY,
                LG_WINDOW_SIZE,
            );
            compressor.write_all(&original).unwrap();
        }
        let mut decompressor = brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE);
        let mut decompressed = Vec::new();
        decompressor.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original, decompressed);
        // Compression should actually reduce size for repetitive data
        assert!(compressed.len() < original.len());
    }

    #[test]
    fn compression_quality_levels() {
        let data = b"Repeating data for compression quality testing. ".repeat(100);
        let compress_at = |q: u32| {
            let mut compressed = Vec::new();
            {
                let mut compressor =
                    brotli::CompressorWriter::new(&mut compressed, BUFFER_SIZE, q, LG_WINDOW_SIZE);
                compressor.write_all(&data).unwrap();
            }
            compressed
        };

        let fast = compress_at(0);
        let default = compress_at(DEFAULT_QUALITY);
        let best = compress_at(11);

        // Higher quality should generally produce smaller output
        assert!(best.len() <= default.len());
        assert!(default.len() <= fast.len());
    }

    #[test]
    fn dict_round_trip() {
        let dict = br#"{"id":0,"name":"user","email":"@example.com"}"#.repeat(10);
        let original = br#"{"id":42,"name":"test_user","email":"test@example.com","active":true}"#;
        let compressed = compress_with_dict_inner(original, &dict, DEFAULT_QUALITY).unwrap();
        let mut decompressor = brotli::Decompressor::new_with_custom_dict(
            compressed.as_slice(),
            BUFFER_SIZE,
            dict.into(),
        );
        let mut decompressed = Vec::new();
        decompressor.read_to_end(&mut decompressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn all_quality_levels_round_trip() {
        let data = b"Quality level test data. ".repeat(50);
        for quality in 0..=11 {
            let mut compressed = Vec::new();
            {
                let mut compressor = brotli::CompressorWriter::new(
                    &mut compressed,
                    BUFFER_SIZE,
                    quality,
                    LG_WINDOW_SIZE,
                );
                compressor.write_all(&data).unwrap();
            }
            let mut decompressor = brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE);
            let mut decompressed = Vec::new();
            decompressor.read_to_end(&mut decompressed).unwrap();
            assert_eq!(data.as_slice(), decompressed.as_slice());
        }
    }

    #[test]
    fn compress_validates_quality() {
        assert!(compress(b"test", Some(12)).is_err());
        assert!(compress(b"test", Some(11)).is_ok());
    }

    #[test]
    fn compress_decompress_round_trip() {
        let original = b"Hello from core-lib brotli!";
        let compressed = compress(original, None).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn dict_round_trip_via_api() {
        let dict = br#"{"key":0,"value":"item"}"#.repeat(10);
        let original = br#"{"key":42,"value":"item_42"}"#;
        let compressed = compress_with_dict(original, &dict, None).unwrap();
        let decompressed = decompress_with_dict(&compressed, &dict).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
