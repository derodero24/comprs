//! The unified codec layer, `comprs_core::unified`: dispatch to the
//! per-format functions, detection, the checks of the options and the
//! stream contexts.

mod common;

use std::sync::LazyLock;

use common::{drive, noise, text};
use comprs_core::dictionary::{Dictionary, DictionaryFormat};
use comprs_core::gzip::GzipHeaderOptions;
use comprs_core::unified::{
    self, CompressContext, CompressOptions, DecompressContext, DecompressOptions, Detection,
    DictionaryRef, Format,
};
use comprs_core::{ComprsError, MemoryUsage, brotli, detect, gzip, lz4, zstd};
use flate2::{Decompress, FlushDecompress};

const DICT: &[u8] = b"stream chunk frame block window level output, a dictionary of the words";

/// [`DICT`], prepared for zstd.
static ZSTD_DICT: LazyLock<Dictionary> =
    LazyLock::new(|| Dictionary::new(DICT, DictionaryFormat::Zstd, None).unwrap());

/// [`DICT`], prepared for brotli.
static BROTLI_DICT: LazyLock<Dictionary> =
    LazyLock::new(|| Dictionary::new(DICT, DictionaryFormat::Brotli, None).unwrap());

/// The formats that detection recognizes: all but deflate-raw.
const DETECTED: [Format; 5] = [
    Format::Zstd,
    Format::Gzip,
    Format::Deflate,
    Format::Brotli,
    Format::Lz4,
];

/// The message of [`ComprsError::UnknownFormat`].
const UNKNOWN_FORMAT: &str = "unable to detect the compression format; pass `format`";

/// Options that compress at `level`.
fn at_level(level: Option<f64>) -> CompressOptions<'static> {
    CompressOptions {
        level,
        ..CompressOptions::default()
    }
}

/// Options that decompress `format`, or detect the format for `None`.
fn as_format(format: Option<Format>) -> DecompressOptions<'static> {
    DecompressOptions {
        format,
        ..DecompressOptions::default()
    }
}

/// The levels of `format` that the tests try: the lowest, the default and
/// the highest, and for zstd the level 0 that selects the default.
fn levels(format: Format) -> Vec<Option<f64>> {
    match format {
        Format::Zstd => vec![Some(-131_072.0), None, Some(0.0), Some(22.0)],
        Format::Gzip | Format::Deflate | Format::DeflateRaw => vec![Some(0.0), None, Some(9.0)],
        Format::Brotli => vec![Some(0.0), None, Some(11.0)],
        Format::Lz4 => vec![None],
    }
}

/// `data` compressed in `format` at `level` by the per-format function.
fn per_format(data: &[u8], format: Format, level: Option<f64>) -> Vec<u8> {
    let signed = level.map(|level| level as i32);
    let unsigned = level.map(|level| level as u32);
    match format {
        Format::Zstd => zstd::compress(data, signed),
        Format::Gzip => gzip::compress(data, unsigned),
        Format::Deflate => gzip::zlib_compress(data, unsigned),
        Format::DeflateRaw => gzip::deflate_compress(data, unsigned),
        Format::Brotli => brotli::compress(data, unsigned),
        Format::Lz4 => lz4::compress(data),
    }
    .unwrap()
}

/// Drive a new decompression context with `options` over `data` in chunks
/// of `chunk_size`.
fn stream_decompress(
    data: &[u8],
    options: &DecompressOptions,
    chunk_size: usize,
) -> Result<Vec<u8>, ComprsError> {
    drive(&mut DecompressContext::new(options)?, data, &[chunk_size])
}

/// Check that `result` failed with [`ComprsError::InvalidArg`] and
/// `message`.
#[track_caller]
fn assert_invalid<T>(result: Result<T, ComprsError>, message: &str) {
    match result {
        Err(ComprsError::InvalidArg(actual)) => assert_eq!(actual, message),
        Err(error) => panic!("expected \"{message}\", got {error:?}"),
        Ok(_) => panic!("expected \"{message}\", got a success"),
    }
}

/// Check that `result` failed with [`ComprsError::UnknownFormat`].
#[track_caller]
fn assert_unknown<T>(result: Result<T, ComprsError>) {
    match result {
        Err(ComprsError::UnknownFormat(message)) => assert_eq!(message, UNKNOWN_FORMAT),
        Err(error) => panic!("expected UnknownFormat, got {error:?}"),
        Ok(_) => panic!("expected UnknownFormat, got a success"),
    }
}

#[test]
fn format_names_are_those_of_the_compression_streams_standard() {
    let names = Format::ALL.map(Format::name);
    assert_eq!(
        names,
        ["zstd", "gzip", "deflate", "deflate-raw", "brotli", "lz4"]
    );
    for format in Format::ALL {
        assert_eq!(Format::from_name(format.name()), Some(format));
        assert_eq!(format.to_string(), format.name());
    }
    for name in ["", "auto", "Deflate", "deflate_raw", "zlib", "br", "gzip "] {
        assert_eq!(Format::from_name(name), None, "{name:?}");
    }
}

#[test]
fn every_format_and_level_gives_the_output_of_the_per_format_function() {
    for format in Format::ALL {
        for level in levels(format) {
            for input in [Vec::new(), text(20_000), noise(5_000, 3)] {
                let case = format!("{format} at level {level:?}, {} bytes", input.len());
                let compressed = unified::compress(&input, format, &at_level(level)).unwrap();
                assert!(
                    compressed == per_format(&input, format, level),
                    "{case}: output differs from the per-format function"
                );
                let output = unified::decompress(&compressed, &as_format(Some(format)));
                assert!(output.unwrap() == input, "{case}");
                if format != Format::DeflateRaw {
                    let output = unified::decompress(&compressed, &as_format(None));
                    assert!(output.unwrap() == input, "{case}, detected");
                }

                // The stream contexts.
                let mut compressor = CompressContext::new(format, &at_level(level)).unwrap();
                let streamed = drive(&mut compressor, &input, &[4096]).unwrap();
                for options in [as_format(Some(format)), as_format(None)] {
                    if options.format.is_none() && format == Format::DeflateRaw {
                        continue;
                    }
                    let output = stream_decompress(&streamed, &options, 1000).unwrap();
                    assert!(
                        output == input,
                        "{case}, streamed with {:?}",
                        options.format
                    );
                }
            }
        }
    }
    // Level 0 selects the default level of zstd.
    let input = text(20_000);
    assert_eq!(
        unified::compress(&input, Format::Zstd, &at_level(Some(0.0))).unwrap(),
        unified::compress(&input, Format::Zstd, &at_level(None)).unwrap()
    );
}

#[test]
fn deflate_is_zlib_and_deflate_raw_is_raw_deflate() {
    let input = text(10_000);
    let zlib = unified::compress(&input, Format::Deflate, &at_level(None)).unwrap();
    let raw = unified::compress(&input, Format::DeflateRaw, &at_level(None)).unwrap();
    // A zlib stream is the raw deflate stream between a 2-byte header and
    // the Adler-32 checksum of the data.
    assert_eq!(zlib[..2], [0x78, 0x9c]);
    assert_eq!(zlib[2..zlib.len() - 4], raw);
    assert!(unified::decompress(&raw, &as_format(Some(Format::Deflate))).is_err());
    assert!(unified::decompress(&zlib, &as_format(Some(Format::DeflateRaw))).is_err());
}

#[test]
fn gzip_header_gives_the_output_of_compress_with_header() {
    let input = text(10_000);
    let header = GzipHeaderOptions {
        filename: Some("unified.txt".to_string()),
        mtime: Some(1_700_000_000),
    };
    for level in [None, Some(1.0)] {
        let options = CompressOptions {
            level,
            gzip_header: Some(header.clone()),
            ..CompressOptions::default()
        };
        let compressed = unified::compress(&input, Format::Gzip, &options).unwrap();
        let level = level.map(|level| level as u32);
        assert_eq!(
            compressed,
            gzip::compress_with_header(&input, &header, level).unwrap()
        );
        let streamed = drive(
            &mut CompressContext::new(Format::Gzip, &options).unwrap(),
            &input,
            &[1000],
        )
        .unwrap();
        for data in [&compressed, &streamed] {
            let read = gzip::read_header(data).unwrap();
            assert_eq!(read.filename.as_deref(), Some("unified.txt"));
            assert_eq!(read.mtime, 1_700_000_000);
            assert!(unified::decompress(data, &as_format(None)).unwrap() == input);
        }
    }
}

#[test]
fn detect_finds_every_format_but_raw_deflate() {
    for input in [text(20_000), noise(5_000, 4), b"a".to_vec(), Vec::new()] {
        for format in Format::ALL {
            let compressed = unified::compress(&input, format, &at_level(None)).unwrap();
            let expected = (format != Format::DeflateRaw).then_some(format);
            let case = format!("{format} of {} bytes", input.len());
            if format == Format::DeflateRaw {
                // Raw deflate has no header. Detection does not take it
                // for zlib, and for brotli only by chance, which none of
                // these streams is.
                assert_eq!(unified::detect(&compressed), None, "{case}");
                continue;
            }
            assert_eq!(unified::detect(&compressed), expected, "{case}");
            assert_eq!(
                unified::detect_prefix(&compressed, true),
                Detection::Known(format),
                "{case}"
            );
        }
    }
    // The formats that detect::detect knows are detected alike.
    let input = text(20_000);
    for (format, compressed) in [
        (detect::Format::Zstd, zstd::compress(&input, None).unwrap()),
        (detect::Format::Gzip, gzip::compress(&input, None).unwrap()),
        (
            detect::Format::Brotli,
            brotli::compress(&input, None).unwrap(),
        ),
        (detect::Format::Lz4, lz4::compress(&input).unwrap()),
    ] {
        assert_eq!(detect::detect(&compressed), format);
        let detected = unified::detect(&compressed).unwrap();
        assert_eq!(detected.name(), format.to_string());
    }
}

/// A brotli stream that starts with `78 9c`, the zlib header that zlib
/// writes by default, and decodes to `content`.
///
/// `78` sets a window of 64 KiB and starts a meta-block that is not the last
/// one, whose length has 6 nibbles; `9c` continues its length, which with
/// the next 12 bits is 0x1009C8 bytes. The meta-block is uncompressed, so
/// that `content` follows as it is. An empty last meta-block (`03`) ends
/// the stream.
fn brotli_with_zlib_header(content: &[u8]) -> Vec<u8> {
    assert_eq!(content.len(), 0x1009C8);
    // The last 12 bits of the length less 1, 0x100, and the bit that marks
    // the meta-block uncompressed.
    [&[0x78, 0x9c, 0x00, 0x11][..], content, &[0x03]].concat()
}

#[test]
fn detect_tells_brotli_from_zlib() {
    let content = text(0x1009C8);
    let compressed = brotli_with_zlib_header(&content);
    assert!(brotli::decompress(&compressed).unwrap() == content);
    // A zlib header, but the deflate data after it is invalid.
    assert_eq!(compressed[..2], [0x78, 0x9c]);
    assert_eq!(unified::detect(&compressed), Some(Format::Brotli));
    assert!(unified::decompress(&compressed, &as_format(None)).unwrap() == content);
    let output = stream_decompress(&compressed, &as_format(None), 4096).unwrap();
    assert!(output == content);
    // The header alone could start either.
    assert_eq!(
        unified::detect_prefix(&compressed[..4], false),
        Detection::NeedMore
    );
}

#[test]
fn detect_prefix_needs_more_until_it_can_tell() {
    let input = text(100_000);
    for format in DETECTED {
        let compressed = unified::compress(&input, format, &at_level(None)).unwrap();
        let mut known_at = None;
        for len in (0..=compressed.len()).step_by(97).chain([compressed.len()]) {
            let detection = unified::detect_prefix(&compressed[..len], false);
            match (detection, known_at) {
                (Detection::NeedMore, None) => {}
                (Detection::Known(detected), _) if detected == format => {
                    known_at.get_or_insert(len);
                }
                _ => panic!("{format}: {detection:?} for {len} bytes, known at {known_at:?}"),
            }
        }
        let known_at = known_at.unwrap();
        match format {
            // Magic numbers.
            Format::Zstd | Format::Gzip | Format::Lz4 => assert!(known_at <= 97, "{format}"),
            // zlib once it inflates to 64 KiB, which this stream does before
            // its end.
            Format::Deflate => {
                assert!(known_at < compressed.len());
                assert!(inflated_len(&compressed[..known_at - 97]) < 64 * 1024);
                assert!(inflated_len(&compressed[..known_at]) >= 64 * 1024);
            }
            // Compressed brotli once it decodes to more than it holds.
            _ => assert!(known_at <= 1000, "{format}: {known_at}"),
        }
    }

    // Short prefixes of the magic numbers and headers.
    for prefix in [
        &[][..],
        &[0x1f],
        &[0x1f, 0x8b],
        &[0x28, 0xb5, 0x2f],
        &[0x04, 0x22],
        &[0x50, 0x2a, 0x4d],
        &[0x78],
        &[0x78, 0x9c],
    ] {
        assert_eq!(
            unified::detect_prefix(prefix, false),
            Detection::NeedMore,
            "{prefix:x?}"
        );
    }
    // A zlib header is zlib when nothing follows; other prefixes are not
    // detected.
    assert_eq!(
        unified::detect_prefix(&[0x78, 0x9c], true),
        Detection::Known(Format::Deflate)
    );
    for prefix in [&[][..], &[0x1f], &[0x1f, 0x8b], &[0x28, 0xb5, 0x2f]] {
        assert_eq!(
            unified::detect_prefix(prefix, true),
            Detection::Unknown,
            "{prefix:x?}"
        );
    }
    // A gzip magic number with another compression method is no gzip.
    assert_eq!(unified::detect(&[0x1f, 0x8b, 0x07, 0x00]), None);
    // Nor is a zlib header with a preset dictionary or a bad checksum.
    assert_eq!(unified::detect(&[0x78, 0xbb, 0x00, 0x00]), None);
    assert_eq!(unified::detect(&[0x78, 0x9d, 0x03, 0x00]), None);
}

/// How many bytes `prefix`, the start of a zlib stream, inflates to.
fn inflated_len(prefix: &[u8]) -> usize {
    let mut output = Vec::with_capacity(1024 * 1024);
    let mut inflater = Decompress::new(true);
    inflater
        .decompress_vec(prefix, &mut output, FlushDecompress::None)
        .unwrap();
    assert!(output.len() < output.capacity());
    output.len()
}

#[test]
fn detect_prefix_takes_zlib_that_inflates_to_64_kib() {
    // zlib data can inflate to a thousand times their size, as these zeros
    // do: detection inflates no more than 64 KiB of them, and then knows
    // that the data is zlib.
    let zeros = vec![0; 1024 * 1024];
    let compressed = unified::compress(&zeros, Format::Deflate, &at_level(None)).unwrap();
    let mut known_at = None;
    for len in 0..compressed.len() {
        let detection = unified::detect_prefix(&compressed[..len], false);
        if detection != Detection::NeedMore {
            assert_eq!(detection, Detection::Known(Format::Deflate));
            known_at = Some(len);
            break;
        }
    }
    let known_at = known_at.unwrap();
    assert!(inflated_len(&compressed[..known_at - 1]) < 64 * 1024);
    assert!(inflated_len(&compressed[..known_at]) >= 64 * 1024);

    // So the stream decodes it before its end.
    let mut ctx = DecompressContext::new(&as_format(None)).unwrap();
    let (body, end) = compressed.split_at(compressed.len() - 1);
    let mut output = ctx.transform(body).unwrap();
    assert!(output.len() >= 64 * 1024);
    output.extend(ctx.transform(end).unwrap());
    output.extend(ctx.finish().unwrap());
    assert!(output == zeros);
}

#[test]
fn detect_rarely_mistakes_random_data_for_a_format() {
    // Random data of 64 KiB or more passes for brotli at times, as it does
    // with detect::detect: it decodes as a long uncompressed meta-block.
    for len in [4, 16, 64, 1024, 16 * 1024] {
        let detected = (0..1000)
            .filter(|&seed| unified::detect(&noise(len, seed + 100)).is_some())
            .count();
        assert_eq!(detected, 0, "{len} bytes");
    }
}

#[test]
fn detect_skips_skippable_frames_before_zstd_and_lz4_only() {
    let input = text(1000);
    let skippable = [
        &0x184D_2A50_u32.to_le_bytes()[..],
        &3u32.to_le_bytes(),
        b"abc",
    ]
    .concat();
    for format in Format::ALL {
        let compressed = unified::compress(&input, format, &at_level(None)).unwrap();
        let data = [&skippable[..], &compressed].concat();
        let expected = matches!(format, Format::Zstd | Format::Lz4).then_some(format);
        assert_eq!(unified::detect(&data), expected, "{format}");
        if let Some(format) = expected {
            assert!(unified::decompress(&data, &as_format(None)).unwrap() == input);
            let output = stream_decompress(&data, &as_format(None), 1).unwrap();
            assert!(output == input, "{format}");
        }
    }
    // Only skippable frames, or the start of one.
    assert_eq!(
        unified::detect_prefix(&skippable, false),
        Detection::NeedMore
    );
    assert_eq!(
        unified::detect_prefix(&skippable[..6], false),
        Detection::NeedMore
    );
    assert_eq!(unified::detect_prefix(&skippable, true), Detection::Unknown);
}

#[test]
fn auto_decoder_takes_any_chunks() {
    for input in [text(5_000), noise(2_000, 5), Vec::new()] {
        for format in DETECTED {
            let compressed = unified::compress(&input, format, &at_level(None)).unwrap();
            for chunk_size in [1, 3, 4, 5, 4096] {
                let output = stream_decompress(&compressed, &as_format(None), chunk_size);
                let case = format!("{format} of {} bytes, chunks of {chunk_size}", input.len());
                assert!(output.unwrap() == input, "{case}");
            }
        }
    }
}

#[test]
fn auto_decoder_holds_at_most_64_kib() {
    // Stored blocks, which detection takes for zlib only after 64 KiB.
    let input = noise(200_000, 6);
    let compressed = unified::compress(&input, Format::Deflate, &at_level(Some(0.0))).unwrap();
    let mut ctx = DecompressContext::new(&as_format(None)).unwrap();
    let mut output = Vec::new();
    for (i, chunk) in compressed.chunks(1000).enumerate() {
        let fed = (i + 1) * 1000;
        output.extend(ctx.transform(chunk).unwrap());
        if fed < 64 * 1024 {
            assert!(output.is_empty(), "{fed} bytes in");
            assert!(ctx.memory_usage() <= 64 * 1024, "{fed} bytes in");
        } else {
            assert!(!output.is_empty(), "{fed} bytes in");
        }
    }
    output.extend(ctx.finish().unwrap());
    assert!(output == input);
}

#[test]
fn auto_decoder_flushes_once_it_knows_the_format() {
    let input = text(10_000);
    let (first, second) = input.split_at(6_000);
    // The lz4 decompression context decodes complete frames only, so its
    // flush ends the input.
    for format in [Format::Zstd, Format::Gzip, Format::Deflate, Format::Brotli] {
        let mut compressor = CompressContext::new(format, &at_level(None)).unwrap();
        let mut flushed = compressor.transform(first).unwrap();
        flushed.extend(compressor.flush().unwrap());
        let mut rest = compressor.transform(second).unwrap();
        rest.extend(compressor.finish().unwrap());

        let mut ctx = DecompressContext::new(&as_format(None)).unwrap();
        let mut output = ctx.transform(&flushed).unwrap();
        output.extend(ctx.flush().unwrap());
        if format == Format::Deflate {
            // A zlib stream is known once it ends.
            assert!(output.is_empty());
        } else {
            // Known from the magic number, or as compressed brotli data,
            // which decodes to more than it holds.
            assert!(output == first, "{format}");
        }
        output.extend(ctx.transform(&rest).unwrap());
        output.extend(ctx.finish().unwrap());
        assert!(output == input, "{format}");
    }
}

#[test]
fn auto_decoder_flush_detects_with_the_input_held() {
    // A whole zlib stream, which the tries at 4, 8, 16 and 32 bytes do not
    // see end.
    let input = text(60);
    let compressed = unified::compress(&input, Format::Deflate, &at_level(None)).unwrap();
    assert!((33..64).contains(&compressed.len()), "{}", compressed.len());
    let mut ctx = DecompressContext::new(&as_format(None)).unwrap();
    assert!(ctx.transform(&compressed).unwrap().is_empty());
    assert!(ctx.flush().unwrap() == input);
    assert!(ctx.finish().unwrap().is_empty());
}

#[test]
fn max_output_size_bounds_the_output() {
    let input = text(20_000);
    let n = input.len();
    let zstd_dict = DictionaryRef::Prepared(&ZSTD_DICT);
    let brotli_dict = DictionaryRef::Raw(DICT);
    let mut cases: Vec<(Format, Option<DictionaryRef>)> =
        Format::ALL.iter().map(|&format| (format, None)).collect();
    cases.extend([
        (Format::Zstd, Some(zstd_dict)),
        (Format::Brotli, Some(brotli_dict)),
    ]);
    for (format, dictionary) in cases {
        let options = CompressOptions {
            dictionary,
            ..CompressOptions::default()
        };
        let compressed = unified::compress(&input, format, &options).unwrap();
        let mut formats = vec![Some(format)];
        if format != Format::DeflateRaw && dictionary.is_none() {
            formats.push(None);
        }
        for format in formats {
            let with_limit = |limit: usize| DecompressOptions {
                format,
                max_output_size: Some(limit as f64),
                dictionary,
            };
            let case = format!("{format:?} with {dictionary:?}");
            let output = unified::decompress(&compressed, &with_limit(n)).unwrap();
            assert!(output == input, "{case}");
            let output = stream_decompress(&compressed, &with_limit(n), 4096).unwrap();
            assert!(output == input, "{case}");
            for result in [
                unified::decompress(&compressed, &with_limit(n - 1)),
                stream_decompress(&compressed, &with_limit(n - 1), 4096),
            ] {
                assert!(
                    matches!(result, Err(ComprsError::SizeLimit { limit, .. }) if limit == n - 1),
                    "{case}: {:?}",
                    result.map(|output| output.len())
                );
            }
        }
    }
}

#[test]
fn zstd_dictionaries_give_the_output_of_the_per_format_functions() {
    let input = text(20_000);
    for level in [None, Some(1.0), Some(19.0)] {
        let signed = level.map(|level| level as i32);
        let raw = CompressOptions {
            level,
            dictionary: Some(DictionaryRef::Raw(DICT)),
            ..CompressOptions::default()
        };
        let prepared = CompressOptions {
            level,
            dictionary: Some(DictionaryRef::Prepared(&ZSTD_DICT)),
            ..CompressOptions::default()
        };
        let with_raw = unified::compress(&input, Format::Zstd, &raw).unwrap();
        assert_eq!(
            with_raw,
            zstd::compress_with_dict(&input, DICT, signed).unwrap()
        );
        let with_prepared = unified::compress(&input, Format::Zstd, &prepared).unwrap();
        assert_eq!(
            with_prepared,
            zstd::compress_prepared(&input, &ZSTD_DICT, signed, 0).unwrap()
        );
        check_dictionary_decoding(Format::Zstd, &ZSTD_DICT, &input, &[with_raw, with_prepared]);
        for options in [raw, prepared] {
            let mut ctx = CompressContext::new(Format::Zstd, &options).unwrap();
            let streamed = drive(&mut ctx, &input, &[1000]).unwrap();
            check_dictionary_decoding(Format::Zstd, &ZSTD_DICT, &input, &[streamed]);
        }
    }
}

#[test]
fn brotli_dictionaries_give_the_output_of_the_per_format_functions() {
    let input = text(20_000);
    for quality in [0, 6, 11] {
        let level = Some(f64::from(quality));
        let raw = CompressOptions {
            level,
            dictionary: Some(DictionaryRef::Raw(DICT)),
            ..CompressOptions::default()
        };
        let prepared = CompressOptions {
            level,
            dictionary: Some(DictionaryRef::Prepared(&BROTLI_DICT)),
            ..CompressOptions::default()
        };
        let expected = brotli::compress_with_dict(&input, DICT, Some(quality)).unwrap();
        let with_raw = unified::compress(&input, Format::Brotli, &raw).unwrap();
        let with_prepared = unified::compress(&input, Format::Brotli, &prepared).unwrap();
        assert_eq!(with_raw, expected, "quality {quality}");
        assert_eq!(with_prepared, expected, "quality {quality}");
        check_dictionary_decoding(Format::Brotli, &BROTLI_DICT, &input, &[with_raw]);
        for options in [raw, prepared] {
            let mut ctx = CompressContext::new(Format::Brotli, &options).unwrap();
            let streamed = drive(&mut ctx, &input, &[1000]).unwrap();
            assert_eq!(streamed, expected, "quality {quality}");
        }
    }
}

/// Check that each of `streams`, compressed from `input` in `format` with
/// the dictionary `prepared`, decodes with the dictionary in every way that
/// the unified layer takes one.
fn check_dictionary_decoding(
    format: Format,
    prepared: &Dictionary,
    input: &[u8],
    streams: &[Vec<u8>],
) {
    let raw = DictionaryRef::Raw(prepared.raw());
    let prepared = DictionaryRef::Prepared(prepared);
    let ways = [
        (Some(format), raw),
        (Some(format), prepared),
        // A prepared dictionary sets the format.
        (None, prepared),
    ];
    for compressed in streams {
        for (format, dictionary) in ways {
            let options = DecompressOptions {
                format,
                dictionary: Some(dictionary),
                ..DecompressOptions::default()
            };
            let case = format!("{format:?} with {dictionary:?}");
            assert!(
                unified::decompress(compressed, &options).unwrap() == input,
                "{case}"
            );
            let output = stream_decompress(compressed, &options, 1000).unwrap();
            assert!(output == input, "{case}");
        }
    }
}

#[test]
fn zstd_workers() {
    // Longer than the 512 KiB that zstd compresses on the calling thread
    // whatever the number of workers.
    let input = text(600 * 1024);
    let with = |workers: f64, dictionary: Option<DictionaryRef<'static>>| CompressOptions {
        level: Some(1.0),
        dictionary,
        workers: Some(workers),
        ..CompressOptions::default()
    };
    if !cfg!(feature = "zstdmt") {
        for dictionary in [None, Some(DictionaryRef::Raw(DICT))] {
            assert_invalid(
                unified::compress(&input, Format::Zstd, &with(2.0, dictionary)),
                "zstd workers are not supported in this build",
            );
            assert_invalid(
                CompressContext::new(Format::Zstd, &with(2.0, dictionary)),
                "zstd workers are not supported in this build",
            );
        }
    }
    let workers: &[u32] = if cfg!(feature = "zstdmt") {
        &[0, 2]
    } else {
        &[0]
    };
    for &n in workers {
        let count = f64::from(n);
        let plain = unified::compress(&input, Format::Zstd, &with(count, None)).unwrap();
        assert_eq!(
            plain,
            zstd::compress_with_workers(&input, Some(1), n).unwrap()
        );
        let raw = unified::compress(
            &input,
            Format::Zstd,
            &with(count, Some(DictionaryRef::Raw(DICT))),
        )
        .unwrap();
        assert_eq!(
            raw,
            zstd::compress_with_dict_and_workers(&input, DICT, Some(1), n).unwrap()
        );
        let prepared = unified::compress(
            &input,
            Format::Zstd,
            &with(count, Some(DictionaryRef::Prepared(&ZSTD_DICT))),
        )
        .unwrap();
        assert_eq!(
            prepared,
            zstd::compress_prepared(&input, &ZSTD_DICT, Some(1), n).unwrap()
        );
        assert!(unified::decompress(&plain, &as_format(None)).unwrap() == input);
        check_dictionary_decoding(Format::Zstd, &ZSTD_DICT, &input, &[raw, prepared]);

        let mut ctx = CompressContext::new(Format::Zstd, &with(count, None)).unwrap();
        let streamed = drive(&mut ctx, &input, &[64 * 1024]).unwrap();
        assert!(unified::decompress(&streamed, &as_format(None)).unwrap() == input);
    }
}

#[test]
fn empty_input_is_truncated_in_a_known_format() {
    for format in Format::ALL {
        for result in [
            unified::decompress(&[], &as_format(Some(format))),
            stream_decompress(&[], &as_format(Some(format)), 1),
        ] {
            assert!(
                matches!(result, Err(ComprsError::Truncated(name)) if name == format.name()),
                "{format}: {result:?}"
            );
        }
    }
    // A prepared dictionary sets the format.
    let options = DecompressOptions {
        dictionary: Some(DictionaryRef::Prepared(&BROTLI_DICT)),
        ..DecompressOptions::default()
    };
    assert!(matches!(
        unified::decompress(&[], &options),
        Err(ComprsError::Truncated("brotli"))
    ));
    // Detection finds no format in empty input.
    assert_unknown(unified::decompress(&[], &as_format(None)));
    assert_unknown(stream_decompress(&[], &as_format(None), 1));
}

#[test]
fn undetected_input_is_of_unknown_format() {
    let raw_deflate =
        unified::compress(&text(20_000), Format::DeflateRaw, &at_level(None)).unwrap();
    for input in [&b"hello world"[..], &noise(1000, 7), &raw_deflate] {
        assert_eq!(unified::detect(input), None);
        assert_unknown(unified::decompress(input, &as_format(None)));
        for chunk_size in [1, 4096] {
            assert_unknown(stream_decompress(input, &as_format(None), chunk_size));
        }
    }

    // The stream keeps failing with the error until finish ends it.
    let mut ctx = DecompressContext::new(&as_format(None)).unwrap();
    assert_unknown(ctx.transform(b"this is not compressed data at all"));
    assert_unknown(ctx.transform(b"more"));
    assert_unknown(ctx.flush());
    assert_unknown(ctx.finish());
    assert!(matches!(
        ctx.transform(b"more"),
        Err(ComprsError::StreamFinished(_))
    ));
}

#[test]
fn brotli_that_detection_guesses_but_does_not_decode_is_of_unknown_format() {
    let input = text(100_000);
    let compressed = unified::compress(&input, Format::Brotli, &at_level(None)).unwrap();
    // The start of a stream that compresses well.
    let cut = &compressed[..compressed.len() / 2];
    // A stream that does not compress, corrupted after the 64 KiB that
    // detection decodes.
    let mut corrupted =
        unified::compress(&noise(100_000, 8), Format::Brotli, &at_level(None)).unwrap();
    *corrupted.last_mut().unwrap() ^= 0xff;
    // A stream with data after its end, which detection does not decode
    // as far as.
    let trailing = [&compressed[..], b"trailing data"].concat();

    let brotli = as_format(Some(Format::Brotli));
    assert!(matches!(
        unified::decompress(cut, &brotli),
        Err(ComprsError::Truncated("brotli"))
    ));
    assert!(unified::decompress(&corrupted, &brotli).is_err());
    assert!(matches!(
        unified::decompress(&trailing, &brotli),
        Err(ComprsError::Corrupt { .. })
    ));
    // detect::detect does not take the cut stream for brotli: it gives up
    // when the first 4 KiB of output do not exceed the input, where the
    // unified detection decodes all the output of the input.
    assert_eq!(detect::detect(cut), detect::Format::Unknown);
    for input in [cut, &corrupted, &trailing] {
        assert_eq!(unified::detect(input), Some(Format::Brotli));
        assert_unknown(unified::decompress(input, &as_format(None)));
        assert_unknown(stream_decompress(input, &as_format(None), 4096));
    }
}

#[test]
fn decoders_are_strict_in_every_format() {
    let input = text(20_000);
    let mut cases: Vec<(Format, Option<DictionaryRef>)> =
        Format::ALL.iter().map(|&format| (format, None)).collect();
    cases.extend([
        (Format::Zstd, Some(DictionaryRef::Raw(DICT))),
        (Format::Brotli, Some(DictionaryRef::Raw(DICT))),
        (Format::Brotli, Some(DictionaryRef::Prepared(&BROTLI_DICT))),
    ]);
    for (format, dictionary) in cases {
        let options = CompressOptions {
            dictionary,
            ..CompressOptions::default()
        };
        let compressed = unified::compress(&input, format, &options).unwrap();
        let decompress = DecompressOptions {
            format: Some(format),
            dictionary,
            ..DecompressOptions::default()
        };
        let case = format!("{format} with {dictionary:?}");
        let len = compressed.len();
        for cut in [1, len / 2, len - 1] {
            let data = &compressed[..cut];
            for result in [
                unified::decompress(data, &decompress),
                stream_decompress(data, &decompress, 1000),
            ] {
                assert!(
                    matches!(result, Err(ComprsError::Truncated(name)) if name == format.name()),
                    "{case} cut to {cut} bytes: {:?}",
                    result.map(|output| output.len())
                );
            }
        }
        let trailing = [&compressed[..], b"trailing garbage"].concat();
        for result in [
            unified::decompress(&trailing, &decompress),
            stream_decompress(&trailing, &decompress, 1000),
        ] {
            assert!(
                matches!(result, Err(ComprsError::Corrupt { .. })),
                "{case}: {:?}",
                result.map(|output| output.len())
            );
        }
    }
}

#[test]
fn compress_options_are_checked() {
    let header = GzipHeaderOptions {
        filename: Some("a\0b".to_string()),
        mtime: None,
    };
    let cases: Vec<(Format, CompressOptions, &str)> = vec![
        (
            Format::Zstd,
            at_level(Some(23.0)),
            "zstd compression level must be an integer between -131072 and 22",
        ),
        (
            Format::Zstd,
            at_level(Some(1.5)),
            "zstd compression level must be an integer between -131072 and 22",
        ),
        (
            Format::Gzip,
            at_level(Some(10.0)),
            "gzip compression level must be an integer between 0 and 9",
        ),
        (
            Format::Deflate,
            at_level(Some(f64::NAN)),
            "deflate compression level must be an integer between 0 and 9",
        ),
        (
            Format::DeflateRaw,
            at_level(Some(-1.0)),
            "deflate-raw compression level must be an integer between 0 and 9",
        ),
        (
            Format::Brotli,
            at_level(Some(12.0)),
            "brotli compression level must be an integer between 0 and 11",
        ),
        (
            Format::Lz4,
            at_level(Some(0.0)),
            "lz4 does not take a compression level",
        ),
        (
            Format::Gzip,
            CompressOptions {
                dictionary: Some(DictionaryRef::Raw(DICT)),
                // The dictionary is checked first.
                level: Some(10.0),
                ..CompressOptions::default()
            },
            "gzip does not support dictionaries",
        ),
        (
            Format::Deflate,
            CompressOptions {
                dictionary: Some(DictionaryRef::Prepared(&ZSTD_DICT)),
                ..CompressOptions::default()
            },
            "deflate does not support dictionaries",
        ),
        (
            Format::DeflateRaw,
            CompressOptions {
                dictionary: Some(DictionaryRef::Raw(DICT)),
                ..CompressOptions::default()
            },
            "deflate-raw does not support dictionaries",
        ),
        (
            Format::Lz4,
            CompressOptions {
                dictionary: Some(DictionaryRef::Raw(DICT)),
                ..CompressOptions::default()
            },
            "lz4 does not support dictionaries",
        ),
        (
            Format::Zstd,
            CompressOptions {
                dictionary: Some(DictionaryRef::Raw(b"")),
                ..CompressOptions::default()
            },
            "dictionary must not be empty",
        ),
        (
            Format::Zstd,
            CompressOptions {
                dictionary: Some(DictionaryRef::Prepared(&BROTLI_DICT)),
                ..CompressOptions::default()
            },
            "this Dictionary is for brotli",
        ),
        (
            Format::Brotli,
            CompressOptions {
                dictionary: Some(DictionaryRef::Prepared(&ZSTD_DICT)),
                ..CompressOptions::default()
            },
            "this Dictionary is for zstd",
        ),
        (
            Format::Zstd,
            CompressOptions {
                gzip_header: Some(GzipHeaderOptions::default()),
                ..CompressOptions::default()
            },
            "gzipHeader applies to gzip compression only",
        ),
        (
            Format::Gzip,
            CompressOptions {
                gzip_header: Some(header.clone()),
                ..CompressOptions::default()
            },
            "gzip filename must not contain NUL characters",
        ),
        (
            Format::Gzip,
            CompressOptions {
                gzip_header: Some(header),
                // The fields of the header are checked last.
                level: Some(10.0),
                ..CompressOptions::default()
            },
            "gzip compression level must be an integer between 0 and 9",
        ),
        (
            Format::Gzip,
            CompressOptions {
                workers: Some(0.0),
                ..CompressOptions::default()
            },
            "workers applies to zstd compression only",
        ),
        (
            Format::Zstd,
            CompressOptions {
                workers: Some(257.0),
                ..CompressOptions::default()
            },
            "zstd workers must be an integer between 0 and 256",
        ),
        (
            Format::Zstd,
            CompressOptions {
                workers: Some(0.5),
                ..CompressOptions::default()
            },
            "zstd workers must be an integer between 0 and 256",
        ),
    ];
    for (format, options, message) in &cases {
        assert_invalid(unified::compress(b"data", *format, options), message);
        assert_invalid(CompressContext::new(*format, options), message);
    }
}

#[test]
fn decompress_options_are_checked() {
    let cases = [
        (
            DecompressOptions {
                dictionary: Some(DictionaryRef::Raw(DICT)),
                ..DecompressOptions::default()
            },
            "pass `format` to decompress with a dictionary",
        ),
        (
            DecompressOptions {
                format: Some(Format::Gzip),
                dictionary: Some(DictionaryRef::Raw(DICT)),
                ..DecompressOptions::default()
            },
            "gzip does not support dictionaries",
        ),
        (
            DecompressOptions {
                format: Some(Format::Zstd),
                dictionary: Some(DictionaryRef::Raw(b"")),
                ..DecompressOptions::default()
            },
            "dictionary must not be empty",
        ),
        (
            DecompressOptions {
                format: Some(Format::Brotli),
                dictionary: Some(DictionaryRef::Prepared(&ZSTD_DICT)),
                // The dictionary is checked first.
                max_output_size: Some(-1.0),
            },
            "this Dictionary is for zstd",
        ),
        (
            DecompressOptions {
                max_output_size: Some(-1.0),
                ..DecompressOptions::default()
            },
            "maxOutputSize must be an integer between 0 and 9007199254740991",
        ),
        (
            DecompressOptions {
                format: Some(Format::Lz4),
                max_output_size: Some(0.5),
                ..DecompressOptions::default()
            },
            "maxOutputSize must be an integer between 0 and 9007199254740991",
        ),
    ];
    let data = unified::compress(b"data", Format::Zstd, &at_level(None)).unwrap();
    for (options, message) in &cases {
        assert_invalid(unified::decompress(&data, options), message);
        assert_invalid(DecompressContext::new(options), message);
    }
}
