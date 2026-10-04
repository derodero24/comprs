//! Zstandard compression and decompression.

use zstd::zstd_safe;

use crate::{ComprsError, IntArg};

/// Default compression level for zstd (same as the C library default).
pub const DEFAULT_LEVEL: i32 = 3;

/// zstd compression levels: negative levels for fast mode down to -131072
/// (`ZSTD_minCLevel()`), and 1 (fastest) to 22 (best compression). Level 0
/// selects [`DEFAULT_LEVEL`].
pub const LEVEL: IntArg<i32> = IntArg {
    name: "zstd compression level",
    min: -131072,
    max: 22,
};

/// Default maximum dictionary size (110 KB, zstd default).
pub const DEFAULT_MAX_DICT_SIZE: usize = 110 * 1024;

/// Largest `max_dict_size` that [`train_dictionary`] accepts (16 MiB).
///
/// zstd recommends dictionaries of about 100 KB, trained on about 100 times
/// as much sample data, so a dictionary of this size already calls for more
/// than a gigabyte of samples. Training allocates several buffers of
/// `max_dict_size` bytes, which the bound keeps within reach of 32-bit and
/// WASM address spaces.
pub const MAX_DICT_SIZE: usize = 16 * 1024 * 1024;

/// The `max_dict_size` of [`train_dictionary`]: at most [`MAX_DICT_SIZE`].
pub const DICT_SIZE: IntArg<usize> = IntArg {
    name: "maxDictSize",
    min: 0,
    max: MAX_DICT_SIZE,
};

/// The most that a zstd frame can expand: a 4-byte RLE block (a 3-byte block
/// header and the byte to repeat) decodes to at most 128 KiB.
const MAX_EXPANSION: u64 = 128 * 1024 / 4;

/// Compress data using Zstandard.
pub fn compress(data: &[u8], level: Option<i32>) -> Result<Vec<u8>, ComprsError> {
    let level = LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;

    zstd::bulk::compress(data, level)
        .map(crate::finish_output)
        .map_err(|e| ComprsError::Operation {
            context: "zstd compress",
            source: e.into(),
        })
}

/// Decompress Zstandard-compressed data.
///
/// The input may hold several frames, including skippable ones. The output
/// is limited to [`crate::MAX_DECOMPRESSED_SIZE`] bytes.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    decompress_with_limit(data, &[], crate::MAX_DECOMPRESSED_SIZE, "zstd decompress")
}

/// Decompress Zstandard-compressed data with explicit capacity.
///
/// `capacity` limits the output size; the output buffer grows with the
/// decompressed data instead of being allocated at that size.
pub fn decompress_with_capacity(data: &[u8], capacity: usize) -> Result<Vec<u8>, ComprsError> {
    decompress_with_limit(data, &[], capacity, "zstd decompress")
}

/// Train a zstd dictionary from sample data.
///
/// `max_dict_size` must not exceed [`MAX_DICT_SIZE`].
pub fn train_dictionary(samples: &[Vec<u8>], max_dict_size: usize) -> Result<Vec<u8>, ComprsError> {
    let max_dict_size = DICT_SIZE.check(max_dict_size)?;
    zstd::dict::from_samples(samples, max_dict_size).map_err(|e| ComprsError::Operation {
        context: "zstd dictionary training",
        source: e.into(),
    })
}

/// Compress data using Zstandard with a pre-trained dictionary.
pub fn compress_with_dict(
    data: &[u8],
    dict: &[u8],
    level: Option<i32>,
) -> Result<Vec<u8>, ComprsError> {
    let level = LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;

    let mut compressor = zstd::bulk::Compressor::with_dictionary(level, dict).map_err(|e| {
        ComprsError::Operation {
            context: "zstd compressor init",
            source: e.into(),
        }
    })?;

    compressor
        .compress(data)
        .map(crate::finish_output)
        .map_err(|e| ComprsError::Operation {
            context: "zstd compress with dict",
            source: e.into(),
        })
}

/// Decompress Zstandard-compressed data that was compressed with a dictionary.
///
/// The output is limited to [`crate::MAX_DECOMPRESSED_SIZE`] bytes.
pub fn decompress_with_dict(data: &[u8], dict: &[u8]) -> Result<Vec<u8>, ComprsError> {
    decompress_with_limit(
        data,
        dict,
        crate::MAX_DECOMPRESSED_SIZE,
        "zstd decompress with dict",
    )
}

/// Decompress Zstandard-compressed data with a dictionary and explicit capacity.
///
/// `capacity` limits the output size, as in [`decompress_with_capacity`].
pub fn decompress_with_dict_with_capacity(
    data: &[u8],
    dict: &[u8],
    capacity: usize,
) -> Result<Vec<u8>, ComprsError> {
    decompress_with_limit(data, dict, capacity, "zstd decompress with dict")
}

/// Decompress `data` with `dict` (empty for none) into at most `limit` bytes.
///
/// When [`trusted_output_size`] knows the exact output size, the frames are
/// decoded straight into a buffer of that size. Otherwise the streaming
/// decoder grows the output as it decodes, so frames without a content size
/// never reserve `limit` bytes up front.
fn decompress_with_limit(
    data: &[u8],
    dict: &[u8],
    limit: usize,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    crate::require_input(data, "zstd")?;
    let init_error = |e: std::io::Error| ComprsError::Operation {
        context: "zstd decompressor init",
        source: e.into(),
    };

    let Some(size) = trusted_output_size(data, limit, context)? else {
        let decoder = crate::zstd_stream::decoder(dict).map_err(|code| ComprsError::Operation {
            context: "zstd decompressor init",
            source: crate::zstd_stream::zstd_error(code),
        })?;
        // Start at the input size: incompressible data then fits as is, and
        // compressible data grows the buffer geometrically.
        return crate::zstd_stream::decompress_all(decoder, data, limit, data.len(), context)
            .map(crate::finish_output);
    };

    let mut output = Vec::new();
    output
        .try_reserve_exact(size)
        .map_err(|e| ComprsError::Operation {
            context,
            source: e.into(),
        })?;
    zstd::bulk::Decompressor::with_dictionary(dict)
        .map_err(init_error)?
        .decompress_to_buffer(data, &mut output)
        .map_err(|e| ComprsError::Operation {
            context,
            source: e.into(),
        })?;
    Ok(crate::finish_output(output))
}

/// The total content size that the frames in `data` declare, if it can size
/// the output buffer: every frame declares its content size (skippable frames
/// declare 0), the frames span all of `data`, and the total is no more than
/// `data` can expand to, so forged headers cannot reserve more memory than
/// valid input of the same length could fill.
///
/// Fails with [`ComprsError::SizeLimit`] if the declared total exceeds
/// `limit`.
fn trusted_output_size(
    data: &[u8],
    limit: usize,
    context: &'static str,
) -> Result<Option<usize>, ComprsError> {
    let mut total: u64 = 0;
    let mut rest = data;
    while !rest.is_empty() {
        let frame_len = match zstd_safe::find_frame_compressed_size(rest) {
            Ok(len) if len > 0 && len <= rest.len() => len,
            _ => return Ok(None),
        };
        let Ok(Some(size)) = zstd_safe::get_frame_content_size(rest) else {
            return Ok(None);
        };
        total = total.saturating_add(size);
        rest = &rest[frame_len..];
    }
    if total > limit as u64 {
        return Err(ComprsError::SizeLimit { context, limit });
    }
    if total > (data.len() as u64).saturating_mul(MAX_EXPANSION) {
        return Ok(None);
    }
    Ok(Some(total as usize))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decompress_rejects_empty_input() {
        let dict = b"zstd dictionary content ".repeat(20);
        for result in [
            decompress(&[]),
            decompress_with_capacity(&[], 1024),
            decompress_with_dict(&[], &dict),
            decompress_with_dict_with_capacity(&[], &dict, 1024),
        ] {
            assert!(matches!(result, Err(ComprsError::Truncated("zstd"))));
        }
    }

    const DICT: &[u8] = b"zstd dictionary content, zstd dictionary content, zstd";

    /// Compress `data` the way streaming encoders do: the frame does not
    /// declare its content size.
    fn compress_without_content_size(data: &[u8]) -> Vec<u8> {
        let mut ctx = crate::zstd_stream::CompressContext::new(None).unwrap();
        let mut frame = ctx.transform(data).unwrap();
        frame.extend(ctx.finish().unwrap());
        assert!(matches!(
            zstd::zstd_safe::get_frame_content_size(&frame),
            Ok(None)
        ));
        frame
    }

    /// Like [`compress_without_content_size`], with [`DICT`].
    fn compress_with_dict_without_content_size(data: &[u8]) -> Vec<u8> {
        let mut ctx = crate::zstd_stream::CompressDictContext::new(DICT, None).unwrap();
        let mut frame = ctx.transform(data).unwrap();
        frame.extend(ctx.finish().unwrap());
        frame
    }

    /// A skippable frame (RFC 8878, section 3.1.2) carrying `payload`.
    fn skippable_frame(payload: &[u8]) -> Vec<u8> {
        let mut frame = 0x184D_2A50u32.to_le_bytes().to_vec();
        frame.extend((payload.len() as u32).to_le_bytes());
        frame.extend(payload);
        frame
    }

    /// Text that compresses well but is not a single repeated byte.
    fn text(len: usize) -> Vec<u8> {
        b"comprs sizes zstd output from the data. "
            .iter()
            .copied()
            .cycle()
            .take(len)
            .collect()
    }

    /// A frame that holds `content` in one raw block but declares
    /// `content_size` as its content size.
    fn frame_declaring(content_size: u64, content: &[u8]) -> Vec<u8> {
        let mut frame = vec![0x28, 0xB5, 0x2F, 0xFD];
        // Frame header descriptor (8-byte content size), 1 KiB window.
        frame.extend([0xC0, 0x00]);
        frame.extend(content_size.to_le_bytes());
        // Block header: last block, raw, `content.len()` bytes.
        let block_header = 1 | ((content.len() as u32) << 3);
        frame.extend(&block_header.to_le_bytes()[..3]);
        frame.extend(content);
        frame
    }

    #[test]
    fn trusted_output_size_sums_declared_sizes_of_complete_frames() {
        let a = compress(&text(1000), None).unwrap();
        let b = compress(&text(3000), None).unwrap();
        let skippable = skippable_frame(b"metadata");
        let input = [&a[..], &skippable[..], &b[..]].concat();
        assert_eq!(
            trusted_output_size(&input, 4000, "test").unwrap(),
            Some(4000)
        );
        assert_eq!(trusted_output_size(&skippable, 0, "test").unwrap(), Some(0));

        let without_size = compress_without_content_size(b"hello");
        let mixed = [&a[..], &without_size[..]].concat();
        let trailing = [&a[..], &[0]].concat();
        for input in [&without_size[..], &mixed, &a[..a.len() - 1], &trailing] {
            assert_eq!(
                trusted_output_size(input, usize::MAX, "test").unwrap(),
                None
            );
        }
    }

    #[test]
    fn trusted_output_size_rejects_sizes_over_the_limit() {
        let frame = frame_declaring(5, b"hello");
        assert_eq!(decompress(&frame).unwrap(), b"hello");
        assert!(matches!(
            trusted_output_size(&frame, 4, "zstd decompress"),
            Err(ComprsError::SizeLimit { limit: 4, .. })
        ));
        assert!(matches!(
            decompress_with_capacity(&frame, 4),
            Err(ComprsError::SizeLimit { limit: 4, .. })
        ));
    }

    #[test]
    fn trusted_output_size_ignores_sizes_the_frames_cannot_fill() {
        // 22 bytes of input decode to at most 22 * 32 KiB, so the declared
        // 200 MiB must not be allocated before decoding finds the frame
        // corrupt.
        let forged = frame_declaring(200 * 1024 * 1024, b"hello");
        assert_eq!(
            trusted_output_size(&forged, usize::MAX, "test").unwrap(),
            None
        );
        assert!(matches!(
            decompress(&forged),
            Err(ComprsError::Operation { .. })
        ));
    }

    #[test]
    fn decompress_sizes_output_from_the_data_without_a_content_size() {
        let small = compress_without_content_size(b"hello");
        let small_dict = compress_with_dict_without_content_size(b"hello");
        for output in [
            decompress(&small).unwrap(),
            decompress_with_capacity(&small, 1 << 40).unwrap(),
            decompress_with_dict(&small_dict, DICT).unwrap(),
            decompress_with_dict_with_capacity(&small_dict, DICT, 1 << 40).unwrap(),
            crate::detect::decompress(&small).unwrap(),
        ] {
            assert_eq!(output, b"hello");
            assert!(output.capacity() < 1024, "capacity {}", output.capacity());
        }

        let original = text(200_000);
        let output = decompress(&compress_without_content_size(&original)).unwrap();
        assert_eq!(output, original);
        assert!(
            output.capacity() <= 2 * original.len(),
            "capacity {}",
            output.capacity()
        );
    }

    #[test]
    fn decompress_allocates_the_declared_content_size_exactly() {
        let original = text(200_000);
        let output = decompress(&compress(&original, None).unwrap()).unwrap();
        assert_eq!(output, original);
        assert_eq!(output.capacity(), original.len());
    }

    #[test]
    fn decompress_treats_capacity_as_a_limit_only() {
        // Capacities that cannot be allocated used to abort the process.
        for frame in [
            compress(b"hello", None).unwrap(),
            compress_without_content_size(b"hello"),
        ] {
            for capacity in [1 << 40, usize::MAX] {
                let output = decompress_with_capacity(&frame, capacity).unwrap();
                assert_eq!(output, b"hello");
                assert!(output.capacity() < 1024, "capacity {}", output.capacity());
            }
        }
        for frame in [
            compress_with_dict(b"hello", DICT, None).unwrap(),
            compress_with_dict_without_content_size(b"hello"),
        ] {
            for capacity in [1 << 40, usize::MAX] {
                let output = decompress_with_dict_with_capacity(&frame, DICT, capacity).unwrap();
                assert_eq!(output, b"hello");
            }
        }
    }

    #[test]
    fn decompress_reports_output_over_the_limit() {
        let original = text(4096);
        for frame in [
            compress(&original, None).unwrap(),
            compress_without_content_size(&original),
        ] {
            assert_eq!(decompress_with_capacity(&frame, 4096).unwrap(), original);
            let err = decompress_with_capacity(&frame, 4095).unwrap_err();
            assert_eq!(
                err.to_string(),
                "zstd decompress exceeded maximum size of 4095 bytes"
            );
        }
        for frame in [
            compress_with_dict(&original, DICT, None).unwrap(),
            compress_with_dict_without_content_size(&original),
        ] {
            assert_eq!(
                decompress_with_dict_with_capacity(&frame, DICT, 4096).unwrap(),
                original
            );
            let err = decompress_with_dict_with_capacity(&frame, DICT, 4095).unwrap_err();
            assert_eq!(
                err.to_string(),
                "zstd decompress with dict exceeded maximum size of 4095 bytes"
            );
        }
    }

    #[test]
    fn decompress_stops_a_bomb_without_a_content_size_at_the_limit() {
        let bomb = compress_without_content_size(&vec![0u8; 8 * 1024 * 1024]);
        assert!(matches!(
            decompress_with_capacity(&bomb, 64 * 1024),
            Err(ComprsError::SizeLimit { limit: 65536, .. })
        ));
    }

    #[test]
    fn decompress_accepts_concatenated_frames() {
        let (a, b) = (vec![b'a'; 4096], vec![b'b'; 4096]);
        let expected = [&a[..], &b[..]].concat();
        let inputs = [
            [compress(&a, None).unwrap(), compress(&b, None).unwrap()].concat(),
            [
                compress(&a, None).unwrap(),
                compress_without_content_size(&b),
            ]
            .concat(),
            [
                compress_without_content_size(&a),
                compress_without_content_size(&b),
            ]
            .concat(),
        ];
        for input in &inputs {
            assert_eq!(decompress(input).unwrap(), expected);
            assert_eq!(
                decompress_with_capacity(input, expected.len()).unwrap(),
                expected
            );
            assert!(matches!(
                decompress_with_capacity(input, expected.len() - 1),
                Err(ComprsError::SizeLimit { .. })
            ));
            assert_eq!(crate::detect::decompress(input).unwrap(), expected);
        }

        let with_size = compress_with_dict(&a, DICT, None).unwrap();
        for second in [
            compress_with_dict(&b, DICT, None).unwrap(),
            compress_with_dict_without_content_size(&b),
        ] {
            let input = [&with_size[..], &second[..]].concat();
            assert_eq!(decompress_with_dict(&input, DICT).unwrap(), expected);
            assert_eq!(
                decompress_with_dict_with_capacity(&input, DICT, expected.len()).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn decompress_skips_skippable_frames() {
        let skippable = skippable_frame(b"metadata");
        let original = text(4096);
        for frame in [
            compress(&original, None).unwrap(),
            compress_without_content_size(&original),
        ] {
            for (input, frames) in [
                ([&skippable[..], &frame[..]].concat(), 1),
                ([&frame[..], &skippable[..]].concat(), 1),
                ([&frame[..], &skippable[..], &frame[..]].concat(), 2),
            ] {
                assert_eq!(decompress(&input).unwrap(), original.repeat(frames));
            }
        }
        assert_eq!(decompress(&skippable).unwrap(), b"");
    }

    #[test]
    fn decompress_rejects_truncated_input() {
        let original = text(8000);
        for frame in [
            compress(&original, None).unwrap(),
            compress_without_content_size(&original),
        ] {
            let concatenated = [&frame[..], &frame[..frame.len() / 2]].concat();
            for input in [
                &frame[..1],
                &frame[..frame.len() / 2],
                &frame[..frame.len() - 1],
                &concatenated[..],
            ] {
                assert!(
                    matches!(decompress(input), Err(ComprsError::Truncated("zstd"))),
                    "input of {} bytes",
                    input.len()
                );
            }
        }
    }

    #[test]
    fn decompress_rejects_data_after_the_last_frame() {
        let mut input = compress(b"complete", None).unwrap();
        input.extend(b"trailing garbage");
        assert!(matches!(
            decompress(&input),
            Err(ComprsError::Operation { .. })
        ));
    }

    #[test]
    fn train_dictionary_rejects_oversized_max_dict_size() {
        let samples: Vec<Vec<u8>> = (0..100)
            .map(|i| format!(r#"{{"key":{i},"value":"item_{i}"}}"#).into_bytes())
            .collect();
        // Used to abort the process when the dictionary buffer was allocated.
        for max_dict_size in [MAX_DICT_SIZE + 1, 1 << 40, usize::MAX] {
            let err = train_dictionary(&samples, max_dict_size).unwrap_err();
            assert!(matches!(err, ComprsError::InvalidArg(_)));
            assert_eq!(
                err.to_string(),
                "maxDictSize must be an integer between 0 and 16777216"
            );
        }
        assert!(train_dictionary(&samples, MAX_DICT_SIZE).is_ok());
    }

    #[test]
    fn round_trip_basic() {
        let original = b"Hello, comprs! This is a test of zstd compression.";
        let compressed = zstd::bulk::compress(original, DEFAULT_LEVEL).unwrap();
        let decompressed = zstd::bulk::decompress(&compressed, original.len()).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn round_trip_empty() {
        let original = b"";
        let compressed = zstd::bulk::compress(original, DEFAULT_LEVEL).unwrap();
        let decompressed = zstd::bulk::decompress(&compressed, 1024).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn round_trip_large() {
        let original: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
        let compressed = zstd::bulk::compress(&original, DEFAULT_LEVEL).unwrap();
        let decompressed = zstd::bulk::decompress(&compressed, original.len()).unwrap();
        assert_eq!(original, decompressed);
        // Compression should actually reduce size for repetitive data
        assert!(compressed.len() < original.len());
    }

    #[test]
    fn compression_levels() {
        let data = b"Repeating data for compression level testing. ".repeat(100);
        let fast = zstd::bulk::compress(&data, 1).unwrap();
        let default = zstd::bulk::compress(&data, DEFAULT_LEVEL).unwrap();
        let best = zstd::bulk::compress(&data, 19).unwrap();

        // Higher levels should generally produce smaller output
        assert!(best.len() <= default.len());
        assert!(default.len() <= fast.len());
    }

    #[test]
    fn level_zero_uses_default() {
        let data = b"Level zero test data. ".repeat(50);
        let with_zero = zstd::bulk::compress(&data, 0).unwrap();
        let decompressed = zstd::bulk::decompress(&with_zero, data.len()).unwrap();
        assert_eq!(data.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn negative_levels() {
        let data = b"Negative level test data. ".repeat(50);
        for level in [-1, -7, -50] {
            let compressed = zstd::bulk::compress(&data, level).unwrap();
            let decompressed = zstd::bulk::decompress(&compressed, data.len()).unwrap();
            assert_eq!(data.as_slice(), decompressed.as_slice());
        }
    }

    #[test]
    fn level_22_max_standard() {
        let data = b"Max level test data. ".repeat(50);
        let compressed = zstd::bulk::compress(&data, 22).unwrap();
        let decompressed = zstd::bulk::decompress(&compressed, data.len()).unwrap();
        assert_eq!(data.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn dict_train_and_round_trip() {
        // Generate sample data (JSON-like patterns)
        let samples: Vec<Vec<u8>> = (0..100)
            .map(|i| {
                format!(
                    r#"{{"id":{},"name":"user_{}","email":"user{}@example.com","active":{}}}"#,
                    i,
                    i,
                    i,
                    i % 2 == 0
                )
                .into_bytes()
            })
            .collect();

        let dict = zstd::dict::from_samples(&samples, DEFAULT_MAX_DICT_SIZE).unwrap();
        assert!(!dict.is_empty());

        // Compress and decompress with dictionary
        let original = br#"{"id":999,"name":"test_user","email":"test@example.com","active":true}"#;
        let mut compressor = zstd::bulk::Compressor::with_dictionary(DEFAULT_LEVEL, &dict).unwrap();
        let compressed = compressor.compress(original).unwrap();

        let mut decompressor = zstd::bulk::Decompressor::with_dictionary(&dict).unwrap();
        let decompressed = decompressor
            .decompress(&compressed, original.len())
            .unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn compress_validates_level() {
        let data = b"test";
        for level in [23, -131073] {
            assert_eq!(
                compress(data, Some(level)).unwrap_err().to_string(),
                "zstd compression level must be an integer between -131072 and 22"
            );
        }
        assert!(compress(data, Some(22)).is_ok());
        assert!(compress(data, Some(-131072)).is_ok());
    }

    #[test]
    fn compress_decompress_round_trip() {
        let original = b"Hello from core-lib!";
        let compressed = compress(original, None).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn dict_round_trip_via_api() {
        let samples: Vec<Vec<u8>> = (0..100)
            .map(|i| format!(r#"{{"key":{},"value":"item_{}"}}"#, i, i).into_bytes())
            .collect();
        let dict = train_dictionary(&samples, DEFAULT_MAX_DICT_SIZE).unwrap();
        let original = br#"{"key":42,"value":"item_42"}"#;
        let compressed = compress_with_dict(original, &dict, None).unwrap();
        let decompressed = decompress_with_dict(&compressed, &dict).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
