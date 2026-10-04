//! Brotli compression and decompression.

use std::io::Write;

use crate::{ComprsError, IntArg};

/// Default compression quality for brotli.
pub const DEFAULT_QUALITY: u32 = 6;

/// Brotli qualities: 0 (fastest) to 11 (best compression).
pub const QUALITY: IntArg<u32> = IntArg {
    name: "brotli quality",
    min: 0,
    max: 11,
};

/// Default buffer size for brotli operations.
pub const BUFFER_SIZE: usize = 4096;

/// Default log2 of the sliding window size for brotli.
pub const LG_WINDOW_SIZE: u32 = 22;

/// Reject a stream that uses the Large Window Brotli extension.
///
/// Such a stream starts with the seven bits 0010001 (`0x11` in the low bits
/// of the first byte), a window size code that RFC 7932 leaves invalid; the
/// next byte then picks a window of up to 1 GiB. brotli-decompressor accepts
/// these streams unless told otherwise, and allocates its ring buffer at the
/// window size whatever the output limit: 12 bytes of input made it allocate
/// 512 MiB. `brotli::Decompressor` has no switch for it, so the one-shot
/// functions check the header themselves; the stream contexts turn
/// `large_window` off in the decoder state. RFC 7932 decoders, Node's zlib
/// among them, reject the same streams.
pub(crate) fn reject_large_window(data: &[u8], context: &'static str) -> Result<(), ComprsError> {
    if data.first().is_some_and(|&byte| byte & 0x7f == 0x11) {
        return Err(ComprsError::Operation {
            context,
            source: "large-window brotli streams are not supported".into(),
        });
    }
    Ok(())
}

/// Compress data using Brotli.
pub fn compress(data: &[u8], quality: Option<u32>) -> Result<Vec<u8>, ComprsError> {
    let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;

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
    crate::require_input(data, "brotli")?;
    reject_large_window(data, "brotli decompress")?;
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
    crate::require_input(data, "brotli")?;
    reject_large_window(data, "brotli decompress")?;
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
    let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;

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
    crate::require_input(data, "brotli")?;
    reject_large_window(data, "brotli decompress with dict")?;
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
    crate::require_input(data, "brotli")?;
    reject_large_window(data, "brotli decompress with dict")?;
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

/// `data` compressed as a Large Window Brotli stream with a window of
/// 2^`lgwin` bytes, for the tests.
#[cfg(test)]
pub(crate) fn compress_large_window(data: &[u8], lgwin: i32) -> Vec<u8> {
    let params = brotli::enc::BrotliEncoderParams {
        quality: 5,
        lgwin,
        large_window: true,
        ..Default::default()
    };
    let mut output = Vec::new();
    brotli::BrotliCompress(&mut &data[..], &mut output, &params).unwrap();
    output
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use super::*;

    #[test]
    fn decompress_rejects_empty_input() {
        let dict = b"brotli dictionary content";
        for result in [
            decompress(&[]),
            decompress_with_capacity(&[], 1024),
            decompress_with_dict(&[], dict),
            decompress_with_dict_with_capacity(&[], dict, 1024),
        ] {
            assert!(matches!(result, Err(ComprsError::Truncated("brotli"))));
        }
    }

    #[test]
    fn decompress_rejects_large_window_streams() {
        let original = b"large window brotli ".repeat(50);
        for lgwin in [22, 30] {
            let compressed = compress_large_window(&original, lgwin);
            assert_eq!(compressed[0] & 0x7f, 0x11, "lgwin {lgwin}");
            assert_eq!(i32::from(compressed[1] & 0x3f), lgwin, "lgwin {lgwin}");
            if lgwin == 22 {
                // brotli-decompressor decodes the stream on its own (the 2^30
                // one too, after allocating 1 GiB, so that one is skipped)...
                let mut decompressed = Vec::new();
                brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE)
                    .read_to_end(&mut decompressed)
                    .unwrap();
                assert_eq!(decompressed, original);
            }
            // ...but comprs rejects it before the decoder allocates the window.
            let dict = b"brotli dictionary";
            for result in [
                decompress(&compressed),
                decompress_with_capacity(&compressed, 1024),
                decompress_with_dict(&compressed, dict),
                decompress_with_dict_with_capacity(&compressed, dict, 1024),
            ] {
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .ends_with("failed: large-window brotli streams are not supported"),
                    "lgwin {lgwin}"
                );
            }
        }
        // The input that the brotli fuzz target found: 12 bytes that made the
        // decoder allocate a 512 MiB ring buffer.
        let fuzzed = [17, 29, 29, 29, 29, 29, 17, 17, 17, 42, 3, 10];
        assert!(
            decompress_with_capacity(&fuzzed, 524_576)
                .unwrap_err()
                .to_string()
                .ends_with("large-window brotli streams are not supported")
        );
    }

    #[test]
    fn decompress_accepts_every_rfc_window_size() {
        let original = b"window sizes ".repeat(50);
        for lgwin in 10..=24 {
            let mut compressed = Vec::new();
            {
                let mut compressor =
                    brotli::CompressorWriter::new(&mut compressed, BUFFER_SIZE, 5, lgwin);
                compressor.write_all(&original).unwrap();
            }
            assert_eq!(decompress(&compressed).unwrap(), original, "lgwin {lgwin}");
        }
    }

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
        assert_eq!(
            compress(b"test", Some(12)).unwrap_err().to_string(),
            "brotli quality must be an integer between 0 and 11"
        );
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
