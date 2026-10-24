//! The strict decoders of raw deflate, zlib and gzip, `decompress_strict`
//! and `StrictDecompressContext`, and the zlib and gzip header encoders that
//! come with them.

mod common;

use std::io::{Read, Write};

use common::{BoxedContext, boxed, drive, noise, text};
use comprs_core::gzip::{self, FlateWrapper, GzipHeaderOptions};
use comprs_core::gzip_stream::{
    DeflateCompressContext, GzipCompressContext, StrictDecompressContext, ZlibCompressContext,
};
use comprs_core::{ComprsError, MAX_DECOMPRESSED_SIZE, MemoryUsage};
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::{Compression, Crc, GzBuilder};

const WRAPPERS: [FlateWrapper; 3] = [FlateWrapper::Raw, FlateWrapper::Zlib, FlateWrapper::Gzip];

/// The chunk sizes in which the tests feed the stream contexts their input.
const CHUNK_SIZES: [usize; 3] = [1, 7, 64 * 1024];

/// The message of the error for data after the end of the stream.
const DATA_AFTER_THE_STREAM: &str = "unexpected data after the end of the compressed stream";

/// `data` compressed in the format of `wrapper` by its one-shot function.
fn compress(data: &[u8], wrapper: FlateWrapper, level: Option<u32>) -> Vec<u8> {
    match wrapper {
        FlateWrapper::Raw => gzip::deflate_compress(data, level),
        FlateWrapper::Zlib => gzip::zlib_compress(data, level),
        FlateWrapper::Gzip => gzip::compress(data, level),
    }
    .unwrap()
}

/// A compression context for the format of `wrapper`.
fn compressor(wrapper: FlateWrapper, level: Option<u32>) -> BoxedContext {
    match wrapper {
        FlateWrapper::Raw => boxed(DeflateCompressContext::new(level)),
        FlateWrapper::Zlib => boxed(ZlibCompressContext::new(level)),
        FlateWrapper::Gzip => boxed(GzipCompressContext::new(level)),
    }
    .unwrap()
}

/// Decode `input` with `decompress_strict` and with a
/// `StrictDecompressContext` fed chunks of each of [`CHUNK_SIZES`], into at
/// most `limit` bytes. Returns each way's description and result.
fn decode_with_limit(
    input: &[u8],
    wrapper: FlateWrapper,
    limit: usize,
) -> Vec<(String, Result<Vec<u8>, ComprsError>)> {
    let name = wrapper.format_name();
    let one_shot = (
        format!("{name} one-shot"),
        gzip::decompress_strict(input, wrapper, limit),
    );
    let streams = CHUNK_SIZES.map(|chunk_size| {
        let mut ctx = StrictDecompressContext::new(wrapper, Some(limit as f64)).unwrap();
        (
            format!("{name} in chunks of {chunk_size}"),
            drive(&mut ctx, input, &[chunk_size]),
        )
    });
    [one_shot].into_iter().chain(streams).collect()
}

/// [`decode_with_limit`] with the default limit.
fn decode(input: &[u8], wrapper: FlateWrapper) -> Vec<(String, Result<Vec<u8>, ComprsError>)> {
    decode_with_limit(input, wrapper, MAX_DECOMPRESSED_SIZE)
}

/// Check that every way of decoding `input` gives `expected`.
fn assert_decodes(input: &[u8], wrapper: FlateWrapper, expected: &[u8], case: &str) {
    for (way, result) in decode(input, wrapper) {
        match result {
            Ok(output) => assert!(output == expected, "{case}, {way}: wrong output"),
            Err(e) => panic!("{case}, {way}: {e}"),
        }
    }
}

/// Check that every way of decoding `input` fails with
/// [`ComprsError::Truncated`] with the name of the format.
fn assert_truncated(input: &[u8], wrapper: FlateWrapper, case: &str) {
    for (way, result) in decode(input, wrapper) {
        assert!(
            matches!(result, Err(ComprsError::Truncated(name)) if name == wrapper.format_name()),
            "{case}, {way}: {:?}",
            result.map(|output| output.len())
        );
    }
}

/// Check that every way of decoding `input` fails with
/// [`ComprsError::Corrupt`] with the message `message`.
fn assert_corrupt(input: &[u8], wrapper: FlateWrapper, message: &str, case: &str) {
    for (way, result) in decode(input, wrapper) {
        match result {
            Err(ComprsError::Corrupt { source, .. }) => {
                assert_eq!(source.to_string(), message, "{case}, {way}");
            }
            other => panic!("{case}, {way}: {:?}", other.map(|output| output.len())),
        }
    }
}

#[test]
fn round_trips_at_every_level_and_chunk_size() {
    for wrapper in WRAPPERS {
        for level in [0, 6, 9] {
            for input in [Vec::new(), text(50_000), noise(70_000, 5)] {
                let case = format!(
                    "{} of {} bytes at level {level}",
                    wrapper.format_name(),
                    input.len()
                );
                assert_decodes(
                    &compress(&input, wrapper, Some(level)),
                    wrapper,
                    &input,
                    &case,
                );

                for chunk_size in CHUNK_SIZES {
                    let compressed = drive(
                        &mut *compressor(wrapper, Some(level)),
                        &input,
                        &[chunk_size],
                    )
                    .unwrap();
                    let output = gzip::decompress_strict(&compressed, wrapper, input.len());
                    assert!(
                        output.unwrap() == input,
                        "{case}, compressed in chunks of {chunk_size}"
                    );
                }
            }
        }
    }
}

#[test]
fn zlib_compress_writes_what_flate2_writes() {
    let input = text(20_000);
    for level in [0, 1, 6, 9] {
        let compressed = gzip::zlib_compress(&input, Some(level)).unwrap();

        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(level));
        encoder.write_all(&input).unwrap();
        assert_eq!(compressed, encoder.finish().unwrap(), "level {level}");

        let mut output = Vec::new();
        ZlibDecoder::new(&compressed[..])
            .read_to_end(&mut output)
            .unwrap();
        assert!(output == input, "level {level}");
    }
    assert_eq!(
        gzip::zlib_compress(&input, None).unwrap(),
        gzip::zlib_compress(&input, Some(gzip::DEFAULT_LEVEL)).unwrap()
    );
}

#[test]
fn zlib_compress_validates_the_level() {
    for result in [
        gzip::zlib_compress(b"data", Some(10)).map(|_| ()),
        ZlibCompressContext::new(Some(10)).map(|_| ()),
    ] {
        let err = result.unwrap_err();
        assert!(matches!(err, ComprsError::InvalidArg(_)));
        assert_eq!(
            err.to_string(),
            "deflate compression level must be an integer between 0 and 9"
        );
    }
}

#[test]
fn decodes_a_zlib_stream_that_node_wrote() {
    // Written by Node.js 22.22.0 from the repository root:
    // node -e "const fs=require('fs'),zlib=require('zlib');fs.writeFileSync('crates/core-lib/tests/fixtures/zlib-node.bin',zlib.deflateSync(fs.readFileSync('crates/core-lib/tests/fixtures/zlib-node.txt')))"
    let compressed = include_bytes!("fixtures/zlib-node.bin");
    let expected = include_bytes!("fixtures/zlib-node.txt");
    // Not a stream that this crate's encoder would write.
    assert_ne!(
        &gzip::zlib_compress(expected, None).unwrap()[..],
        compressed
    );
    assert_decodes(compressed, FlateWrapper::Zlib, expected, "node fixture");
}

/// The lengths at which the tests cut a stream of `len` bytes: inside the
/// header, the data and the trailer.
fn cuts(len: usize) -> [usize; 6] {
    [0, 1, 2, len / 2, len - 4, len - 1]
}

#[test]
fn raw_deflate_rejects_truncated_input_and_data_after_the_stream() {
    let wrapper = FlateWrapper::Raw;
    let input = text(10_000);
    let compressed = compress(&input, wrapper, None);
    for cut in cuts(compressed.len()) {
        assert_truncated(&compressed[..cut], wrapper, &format!("cut to {cut}"));
    }

    let with_junk = [&compressed[..], b"xyz"].concat();
    assert_corrupt(&with_junk, wrapper, DATA_AFTER_THE_STREAM, "xyz");
    // Raw deflate has no framing that could start another stream.
    let twice = [&compressed[..], &compressed[..]].concat();
    assert_corrupt(&twice, wrapper, DATA_AFTER_THE_STREAM, "two streams");

    assert_corrupt(&[0xff; 16], wrapper, "corrupt deflate stream", "garbage");
}

#[test]
fn zlib_rejects_truncated_input_and_data_after_the_stream() {
    let wrapper = FlateWrapper::Zlib;
    let input = text(10_000);
    let compressed = compress(&input, wrapper, None);
    for cut in cuts(compressed.len()) {
        assert_truncated(&compressed[..cut], wrapper, &format!("cut to {cut}"));
    }

    let with_junk = [&compressed[..], b"xyz"].concat();
    assert_corrupt(&with_junk, wrapper, DATA_AFTER_THE_STREAM, "xyz");
    let twice = [&compressed[..], &compressed[..]].concat();
    assert_corrupt(&twice, wrapper, DATA_AFTER_THE_STREAM, "two streams");

    // Raw deflate and gzip are not zlib.
    let raw = compress(&input, FlateWrapper::Raw, None);
    assert_corrupt(&raw, wrapper, "incorrect header check", "raw deflate");
    let gzipped = compress(&input, FlateWrapper::Gzip, None);
    assert_corrupt(&gzipped, wrapper, "incorrect header check", "gzip");
}

#[test]
fn zlib_rejects_a_preset_dictionary() {
    // A zlib header that sets FDICT, then the Adler-32 of the dictionary.
    let input = [0x78, 0xbb, 0x00, 0x00, 0x00, 0x01, 0x03, 0x00];
    assert_corrupt(
        &input,
        FlateWrapper::Zlib,
        "zlib preset dictionaries are not supported",
        "FDICT",
    );
}

#[test]
fn gzip_decodes_every_member() {
    let wrapper = FlateWrapper::Gzip;
    let (first, second) = (text(10_000), noise(3_000, 6));
    let members = [
        compress(&first, wrapper, None),
        compress(&second, wrapper, Some(1)),
        compress(b"", wrapper, None),
    ];
    let expected = [&first[..], &second[..]].concat();
    assert_decodes(&members.concat(), wrapper, &expected, "three members");
    assert_decodes(&members[2], wrapper, b"", "an empty member");
}

#[test]
fn gzip_reads_every_header_field() {
    let wrapper = FlateWrapper::Gzip;
    // A header with an extra field, a file name and a comment, which zlib
    // skips, and a CRC-16 of the header, which it checks.
    let mut encoder = GzBuilder::new()
        .extra(vec![1, 2, 3, 4])
        .filename("name.txt")
        .comment("comment")
        .write(Vec::new(), Compression::default());
    encoder.write_all(b"data").unwrap();
    let mut member = encoder.finish().unwrap();
    // The fixed fields, XLEN and the extra field, then the file name and the
    // comment, each NUL-terminated.
    let header_len = 10 + 2 + 4 + b"name.txt\0".len() + b"comment\0".len();
    member[3] |= 0x02; // FHCRC
    let mut crc = Crc::new();
    crc.update(&member[..header_len]);
    let crc16 = (crc.sum() as u16).to_le_bytes();
    member.splice(header_len..header_len, crc16);
    // flate2's own decoder accepts the header too.
    assert_eq!(gzip::decompress(&member).unwrap(), b"data");

    let two = [&member[..], &member[..]].concat();
    assert_decodes(&two, wrapper, b"datadata", "two members");
    // Cuts in the header of a later member.
    for cut in [11, 14, 20, header_len, header_len + 1] {
        let input = [&member[..], &member[..cut]].concat();
        assert_truncated(&input, wrapper, &format!("header cut to {cut}"));
    }
    let mut bad_crc = member.clone();
    bad_crc[header_len] ^= 0xff;
    assert_corrupt(&bad_crc, wrapper, "header crc mismatch", "CRC-16");
}

#[test]
fn gzip_rejects_truncated_input_and_data_after_the_stream() {
    let wrapper = FlateWrapper::Gzip;
    let first = compress(&text(10_000), wrapper, None);
    let second = compress(&noise(3_000, 6), wrapper, None);
    for cut in cuts(first.len()) {
        assert_truncated(&first[..cut], wrapper, &format!("cut to {cut}"));
    }
    // A later member that is cut, also after its first byte, which could
    // still be the start of another member.
    for cut in [1, 2, 10, second.len() / 2, second.len() - 1] {
        let input = [&first[..], &second[..cut]].concat();
        assert_truncated(&input, wrapper, &format!("second member cut to {cut}"));
    }

    for junk in [&b"xyz"[..], &[0x1f, 0x8c], &[0x8b, 0x1f]] {
        for members in [&first[..], &[&first[..], &second[..]].concat()] {
            let input = [members, junk].concat();
            assert_corrupt(&input, wrapper, DATA_AFTER_THE_STREAM, &format!("{junk:?}"));
        }
    }
    // A zlib stream after a member is not another member.
    let zlib = compress(b"zlib", FlateWrapper::Zlib, None);
    let input = [&first[..], &zlib[..]].concat();
    assert_corrupt(&input, wrapper, DATA_AFTER_THE_STREAM, "zlib");
    // Another member starts with the magic bytes, but its header must be
    // valid.
    let input = [&first[..], &[0x1f, 0x8b, 0x07, 0x00]].concat();
    assert_corrupt(&input, wrapper, "unknown compression method", "CM 7");
}

/// `input` with the byte at `index` from its end inverted.
fn flip_from_end(input: &[u8], index: usize) -> Vec<u8> {
    let mut output = input.to_vec();
    let i = output.len() - 1 - index;
    output[i] ^= 0xff;
    output
}

#[test]
fn checksum_mismatches_are_corrupt() {
    let input = text(10_000);

    // The Adler-32 checksum ends the zlib stream.
    let zlib = compress(&input, FlateWrapper::Zlib, None);
    let bad_adler = flip_from_end(&zlib, 0);
    assert_corrupt(
        &bad_adler,
        FlateWrapper::Zlib,
        "incorrect data check",
        "Adler-32",
    );

    // The gzip trailer is the CRC-32, then the size of the data.
    let gzipped = compress(&input, FlateWrapper::Gzip, None);
    let bad_crc = flip_from_end(&gzipped, 4);
    assert_corrupt(
        &bad_crc,
        FlateWrapper::Gzip,
        "incorrect data check",
        "CRC-32",
    );
    let bad_size = flip_from_end(&gzipped, 0);
    assert_corrupt(
        &bad_size,
        FlateWrapper::Gzip,
        "incorrect length check",
        "ISIZE",
    );
    // Also in a later member.
    let input = [&gzipped[..], &bad_crc].concat();
    assert_corrupt(
        &input,
        FlateWrapper::Gzip,
        "incorrect data check",
        "second CRC-32",
    );
}

#[test]
fn max_output_bounds_the_output() {
    // Text, and a bomb that expands about 1000 times.
    for input in [text(50_000), vec![0; 1024 * 1024]] {
        let n = input.len();
        for wrapper in WRAPPERS {
            let mut compressed = compress(&input, wrapper, None);
            if wrapper == FlateWrapper::Gzip {
                // The limit spans the members: n bytes in two members.
                let (first, second) = input.split_at(n / 3);
                compressed = [
                    compress(first, wrapper, None),
                    compress(second, wrapper, None),
                ]
                .concat();
            }
            for (way, result) in decode_with_limit(&compressed, wrapper, n) {
                assert!(result.unwrap() == input, "{way} into {n} bytes");
            }
            for limit in [n - 1, 0] {
                for (way, result) in decode_with_limit(&compressed, wrapper, limit) {
                    assert!(
                        matches!(result, Err(ComprsError::SizeLimit { limit: l, .. }) if l == limit),
                        "{way} into {limit} bytes: {:?}",
                        result.map(|output| output.len())
                    );
                }
            }
        }
    }
}

#[test]
fn a_failed_context_keeps_failing() {
    let data = text(10_000);
    for wrapper in WRAPPERS {
        let compressed = compress(&data, wrapper, None);
        let cases = [
            (
                "data after the stream",
                [&compressed[..], b"xyz"].concat(),
                None,
            ),
            ("corrupt data", vec![0xff; 16], None),
            ("output limit", compressed.clone(), Some(data.len() - 1)),
        ];
        for (case, input, limit) in cases {
            let case = format!("{}, {case}", wrapper.format_name());
            let limit = limit.map(|limit| limit as f64);
            let mut ctx = StrictDecompressContext::new(wrapper, limit).unwrap();
            let error = ctx.transform(&input).unwrap_err();
            // The decoder is dropped, and so is the output that it decoded
            // before the error.
            assert_eq!(ctx.memory_usage(), 0, "{case}");

            // Every later call fails with the same error, finish() too: the
            // data before the junk must not decode after all.
            let later = [
                ctx.transform(b""),
                ctx.transform(&compressed),
                ctx.flush(),
                ctx.finish(),
            ];
            for result in later {
                match result {
                    Err(e) => {
                        assert_eq!(e.code(), error.code(), "{case}");
                        assert_eq!(e.to_string(), error.to_string(), "{case}");
                    }
                    Ok(output) => panic!("{case}: {} bytes", output.len()),
                }
            }
            // finish() ended the stream.
            assert!(
                matches!(ctx.transform(b""), Err(ComprsError::StreamFinished(_))),
                "{case}"
            );
            assert_eq!(ctx.memory_usage(), 0, "{case}");
        }
    }
}

#[test]
fn errors_name_the_format() {
    let truncated = |wrapper| gzip::decompress_strict(&[], wrapper, 100).unwrap_err();
    assert_eq!(
        truncated(FlateWrapper::Raw).to_string(),
        "deflate-raw stream is truncated: unexpected end of input"
    );
    assert_eq!(
        truncated(FlateWrapper::Zlib).to_string(),
        "deflate stream is truncated: unexpected end of input"
    );
    assert_eq!(
        truncated(FlateWrapper::Gzip).to_string(),
        "gzip stream is truncated: unexpected end of input"
    );

    let input = [&compress(b"data", FlateWrapper::Zlib, None)[..], b"xyz"].concat();
    let err = gzip::decompress_strict(&input, FlateWrapper::Zlib, 100).unwrap_err();
    assert_eq!(
        err.to_string(),
        "deflate decompress failed: unexpected data after the end of the compressed stream"
    );

    let mut ctx = StrictDecompressContext::new(FlateWrapper::Raw, None).unwrap();
    let err = ctx.transform(&[0xff; 16]).unwrap_err();
    assert_eq!(
        err.to_string(),
        "deflate-raw stream decompress failed: corrupt deflate stream"
    );
    // finish() reports the error of transform() again.
    let err = ctx.finish().unwrap_err();
    assert_eq!(
        err.to_string(),
        "deflate-raw stream decompress failed: corrupt deflate stream"
    );
    assert!(matches!(
        ctx.finish(),
        Err(ComprsError::StreamFinished("deflate-raw stream"))
    ));

    let mut ctx = StrictDecompressContext::new(FlateWrapper::Zlib, None).unwrap();
    let err = ctx.finish().unwrap_err();
    assert_eq!(
        err.to_string(),
        "deflate stream is truncated: unexpected end of input"
    );
    assert!(matches!(
        ctx.transform(b"more"),
        Err(ComprsError::StreamFinished("deflate stream"))
    ));
}

#[test]
fn gzip_compress_context_with_header_writes_what_compress_with_header_writes() {
    let input = text(20_000);
    let headers = [
        GzipHeaderOptions::default(),
        GzipHeaderOptions {
            filename: Some("data.txt".to_string()),
            mtime: None,
        },
        GzipHeaderOptions {
            filename: None,
            mtime: Some(1_700_000_000),
        },
        GzipHeaderOptions {
            filename: Some("名前.txt".to_string()),
            mtime: Some(u32::MAX),
        },
    ];
    for header in &headers {
        for level in [None, Some(0), Some(9)] {
            let case = format!("{header:?} at level {level:?}");
            let expected = gzip::compress_with_header(&input, header, level).unwrap();
            // One transform call, without the flush that drive() adds,
            // writes what the one-shot function writes.
            let mut ctx = GzipCompressContext::with_header(level, header).unwrap();
            let compressed = [ctx.transform(&input).unwrap(), ctx.finish().unwrap()].concat();
            assert!(compressed == expected, "{case}");

            let parsed = gzip::read_header(&compressed).unwrap();
            assert_eq!(parsed.filename, header.filename, "{case}");
            assert_eq!(parsed.mtime, header.mtime.unwrap_or(0), "{case}");
        }
    }
    // new(), which calls with_header(), still writes what flate2's
    // GzEncoder::new writes, as gzip::compress does.
    for level in [None, Some(0), Some(9)] {
        let mut ctx = GzipCompressContext::new(level).unwrap();
        let compressed = [ctx.transform(&input).unwrap(), ctx.finish().unwrap()].concat();
        let expected = gzip::compress(&input, level).unwrap();
        assert!(compressed == expected, "new() at level {level:?}");
    }
}

#[test]
fn gzip_compress_context_with_header_validates_its_arguments() {
    let header = |filename: &str| GzipHeaderOptions {
        filename: Some(filename.to_string()),
        mtime: None,
    };
    let cases = [
        (
            header("a\0b"),
            None,
            "gzip filename must not contain NUL characters",
        ),
        (
            header(&"f".repeat(gzip::MAX_FILENAME_LEN + 1)),
            None,
            "gzip filename must be at most 65535 bytes long",
        ),
        (
            header("name"),
            Some(10),
            "gzip compression level must be an integer between 0 and 9",
        ),
    ];
    for (header, level, message) in cases {
        let err = GzipCompressContext::with_header(level, &header)
            .err()
            .unwrap();
        assert!(matches!(err, ComprsError::InvalidArg(_)), "{message}");
        assert_eq!(err.to_string(), message);
    }
}
