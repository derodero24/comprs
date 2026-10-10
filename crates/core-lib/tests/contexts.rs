//! The stream contexts of every format, driven through their public API.

mod common;

use std::sync::LazyLock;

use common::{BoxedContext, boxed, drive, noise, text};
use comprs_core::dictionary::{Dictionary, DictionaryFormat};
use comprs_core::gzip::{FlateWrapper, GzipHeaderOptions};
use comprs_core::unified::{self, CompressOptions, DecompressOptions, DictionaryRef, Format};
use comprs_core::{
    ComprsError, MAX_DECOMPRESSED_SIZE, brotli, brotli_stream, gzip, gzip_stream, lz4, lz4_stream,
    zstd, zstd_stream,
};

const DICT: &[u8] = b"stream chunk frame block window level output, a dictionary";

/// [`DICT`], prepared for zstd.
static PREPARED: LazyLock<Dictionary> =
    LazyLock::new(|| Dictionary::new(DICT, DictionaryFormat::Zstd, None).unwrap());

/// [`DICT`], prepared for brotli.
static BROTLI_PREPARED: LazyLock<Dictionary> =
    LazyLock::new(|| Dictionary::new(DICT, DictionaryFormat::Brotli, None).unwrap());

/// Workers for the zstd contexts that take them. Builds without the zstdmt
/// feature accept only 0.
const ZSTD_WORKERS: u32 = if cfg!(feature = "zstdmt") { 2 } else { 0 };

/// The gzip header that the "gzip with header" contexts write.
fn header() -> GzipHeaderOptions {
    GzipHeaderOptions {
        filename: Some("contexts.txt".to_string()),
        mtime: Some(1_700_000_000),
    }
}

/// A strict decompression context for the format of `wrapper`.
fn strict(
    wrapper: FlateWrapper,
    limit: Option<f64>,
) -> Result<gzip_stream::StrictDecompressContext, ComprsError> {
    gzip_stream::StrictDecompressContext::new(wrapper, limit)
}

/// The one-shot strict decoder of the format of `wrapper`.
fn strict_one_shot(data: &[u8], wrapper: FlateWrapper) -> Result<Vec<u8>, ComprsError> {
    gzip::decompress_strict(data, wrapper, MAX_DECOMPRESSED_SIZE)
}

/// A one-shot function of the same format, for comparison.
type OneShot = fn(&[u8]) -> Result<Vec<u8>, ComprsError>;

/// The stream contexts of one format.
struct Codec {
    name: &'static str,
    /// A compression context at the default level.
    compressor: fn() -> Result<BoxedContext, ComprsError>,
    /// A decompression context with an optional output limit.
    decompressor: fn(Option<f64>) -> Result<BoxedContext, ComprsError>,
    compress: OneShot,
    decompress: OneShot,
    /// Whether the output of the compressor's `flush` decodes, without the
    /// rest of the stream, to all the input so far. The brotli dictionary
    /// context buffers its input until `finish`, and the buffered lz4
    /// decompression context decodes only complete frames.
    flush_emits_input: bool,
}

/// The [`Codec`] of the unified contexts that compress in `$format` with
/// `$dictionary` and `$workers`, and decompress as `$decode_as` (`None` to
/// detect the format) with the same dictionary.
macro_rules! unified_codec {
    (
        $name:literal,
        $format:expr,
        decode_as: $decode_as:expr,
        dictionary: $dictionary:expr,
        workers: $workers:expr,
        flush_emits_input: $flush_emits_input:literal $(,)?
    ) => {
        Codec {
            name: $name,
            compressor: || {
                let options = CompressOptions {
                    dictionary: $dictionary,
                    workers: $workers,
                    ..CompressOptions::default()
                };
                boxed(unified::CompressContext::new($format, &options))
            },
            decompressor: |limit| {
                let options = DecompressOptions {
                    format: $decode_as,
                    max_output_size: limit,
                    dictionary: $dictionary,
                };
                boxed(unified::DecompressContext::new(&options))
            },
            compress: |data| {
                let options = CompressOptions {
                    dictionary: $dictionary,
                    workers: $workers,
                    ..CompressOptions::default()
                };
                unified::compress(data, $format, &options)
            },
            decompress: |data| {
                let options = DecompressOptions {
                    format: $decode_as,
                    max_output_size: None,
                    dictionary: $dictionary,
                };
                unified::decompress(data, &options)
            },
            flush_emits_input: $flush_emits_input,
        }
    };
}

const CODECS: &[Codec] = &[
    Codec {
        name: "gzip",
        compressor: || boxed(gzip_stream::GzipCompressContext::new(None)),
        decompressor: |limit| boxed(gzip_stream::GzipDecompressContext::new(limit)),
        compress: |data| gzip::compress(data, None),
        decompress: gzip::decompress,
        flush_emits_input: true,
    },
    Codec {
        name: "deflate",
        compressor: || boxed(gzip_stream::DeflateCompressContext::new(None)),
        decompressor: |limit| boxed(gzip_stream::DeflateDecompressContext::new(limit)),
        compress: |data| gzip::deflate_compress(data, None),
        decompress: gzip::deflate_decompress,
        flush_emits_input: true,
    },
    Codec {
        name: "gzip with header",
        compressor: || {
            boxed(gzip_stream::GzipCompressContext::with_header(
                None,
                &header(),
            ))
        },
        decompressor: |limit| boxed(gzip_stream::GzipDecompressContext::new(limit)),
        compress: |data| gzip::compress_with_header(data, &header(), None),
        decompress: gzip::decompress,
        flush_emits_input: true,
    },
    Codec {
        name: "gzip strict",
        compressor: || boxed(gzip_stream::GzipCompressContext::new(None)),
        decompressor: |limit| boxed(strict(FlateWrapper::Gzip, limit)),
        compress: |data| gzip::compress(data, None),
        decompress: |data| strict_one_shot(data, FlateWrapper::Gzip),
        flush_emits_input: true,
    },
    Codec {
        name: "zlib",
        compressor: || boxed(gzip_stream::ZlibCompressContext::new(None)),
        decompressor: |limit| boxed(strict(FlateWrapper::Zlib, limit)),
        compress: |data| gzip::zlib_compress(data, None),
        decompress: |data| strict_one_shot(data, FlateWrapper::Zlib),
        flush_emits_input: true,
    },
    Codec {
        name: "deflate-raw strict",
        compressor: || boxed(gzip_stream::DeflateCompressContext::new(None)),
        decompressor: |limit| boxed(strict(FlateWrapper::Raw, limit)),
        compress: |data| gzip::deflate_compress(data, None),
        decompress: |data| strict_one_shot(data, FlateWrapper::Raw),
        flush_emits_input: true,
    },
    Codec {
        name: "brotli",
        compressor: || boxed(brotli_stream::CompressContext::new(None)),
        decompressor: |limit| boxed(brotli_stream::DecompressContext::new(limit)),
        compress: |data| brotli::compress(data, None),
        decompress: brotli::decompress,
        flush_emits_input: true,
    },
    Codec {
        name: "brotli dict",
        compressor: || boxed(brotli_stream::CompressDictContext::new(DICT, None)),
        decompressor: |limit| boxed(brotli_stream::DecompressDictContext::new(DICT, limit)),
        compress: |data| brotli::compress_with_dict(data, DICT, None),
        decompress: |data| brotli::decompress_with_dict(data, DICT),
        flush_emits_input: false,
    },
    Codec {
        name: "zstd",
        compressor: || boxed(zstd_stream::CompressContext::new(None)),
        decompressor: |limit| boxed(zstd_stream::DecompressContext::new(limit)),
        compress: |data| zstd::compress(data, None),
        decompress: zstd::decompress,
        flush_emits_input: true,
    },
    Codec {
        name: "zstd dict",
        compressor: || boxed(zstd_stream::CompressDictContext::new(DICT, None)),
        decompressor: |limit| boxed(zstd_stream::DecompressDictContext::new(DICT, limit)),
        compress: |data| zstd::compress_with_dict(data, DICT, None),
        decompress: |data| zstd::decompress_with_dict(data, DICT),
        flush_emits_input: true,
    },
    Codec {
        // The context uses the workers however short the stream, the
        // one-shot function for inputs above 512 KiB.
        name: "zstd workers",
        compressor: || {
            boxed(zstd_stream::CompressContext::with_workers(
                None,
                ZSTD_WORKERS,
            ))
        },
        decompressor: |limit| boxed(zstd_stream::DecompressContext::new(limit)),
        compress: |data| zstd::compress_with_workers(data, None, ZSTD_WORKERS),
        decompress: zstd::decompress,
        flush_emits_input: true,
    },
    Codec {
        name: "zstd dict workers",
        compressor: || {
            boxed(zstd_stream::CompressDictContext::with_workers(
                DICT,
                None,
                ZSTD_WORKERS,
            ))
        },
        decompressor: |limit| boxed(zstd_stream::DecompressDictContext::new(DICT, limit)),
        compress: |data| zstd::compress_with_dict_and_workers(data, DICT, None, ZSTD_WORKERS),
        decompress: |data| zstd::decompress_with_dict(data, DICT),
        flush_emits_input: true,
    },
    Codec {
        name: "zstd prepared dict",
        compressor: || {
            boxed(zstd_stream::CompressDictContext::with_prepared(
                &PREPARED,
                None,
                ZSTD_WORKERS,
            ))
        },
        decompressor: |limit| {
            boxed(zstd_stream::DecompressDictContext::with_prepared(
                &PREPARED, limit,
            ))
        },
        compress: |data| zstd::compress_prepared(data, &PREPARED, None, ZSTD_WORKERS),
        decompress: |data| zstd::decompress_prepared(data, &PREPARED, MAX_DECOMPRESSED_SIZE),
        flush_emits_input: true,
    },
    Codec {
        name: "lz4",
        compressor: || boxed(Ok(lz4_stream::CompressContext::new())),
        decompressor: |limit| boxed(lz4_stream::DecompressContext::new(limit)),
        compress: lz4::compress,
        decompress: lz4::decompress,
        flush_emits_input: false,
    },
    Codec {
        name: "lz4 incremental",
        compressor: || boxed(Ok(lz4_stream::CompressContext::new())),
        decompressor: |limit| boxed(lz4_stream::DecompressContext::incremental(limit)),
        compress: lz4::compress,
        decompress: lz4::decompress,
        flush_emits_input: true,
    },
    unified_codec!(
        "unified zstd dict workers",
        Format::Zstd,
        decode_as: Some(Format::Zstd),
        dictionary: Some(DictionaryRef::Raw(DICT)),
        workers: Some(f64::from(ZSTD_WORKERS)),
        flush_emits_input: true,
    ),
    unified_codec!(
        "unified zstd prepared dict",
        Format::Zstd,
        // The format of the dictionary.
        decode_as: None,
        dictionary: Some(DictionaryRef::Prepared(&PREPARED)),
        workers: None,
        flush_emits_input: true,
    ),
    unified_codec!(
        "unified deflate",
        Format::Deflate,
        decode_as: Some(Format::Deflate),
        dictionary: None,
        workers: None,
        flush_emits_input: true,
    ),
    unified_codec!(
        "unified deflate-raw",
        Format::DeflateRaw,
        decode_as: Some(Format::DeflateRaw),
        dictionary: None,
        workers: None,
        flush_emits_input: true,
    ),
    unified_codec!(
        "unified brotli prepared dict",
        Format::Brotli,
        decode_as: Some(Format::Brotli),
        dictionary: Some(DictionaryRef::Prepared(&BROTLI_PREPARED)),
        workers: None,
        flush_emits_input: false,
    ),
    // Detection, which holds the input until it knows the format: zlib only
    // once the stream ends. These also cover the contexts that the unified
    // layer creates for zstd, gzip, brotli and lz4.
    unified_codec!(
        "unified auto zstd",
        Format::Zstd,
        decode_as: None,
        dictionary: None,
        workers: None,
        flush_emits_input: true,
    ),
    unified_codec!(
        "unified auto gzip",
        Format::Gzip,
        decode_as: None,
        dictionary: None,
        workers: None,
        flush_emits_input: true,
    ),
    unified_codec!(
        "unified auto deflate",
        Format::Deflate,
        decode_as: None,
        dictionary: None,
        workers: None,
        flush_emits_input: false,
    ),
    unified_codec!(
        "unified auto brotli",
        Format::Brotli,
        decode_as: None,
        dictionary: None,
        workers: None,
        flush_emits_input: true,
    ),
    unified_codec!(
        "unified auto lz4",
        Format::Lz4,
        decode_as: None,
        dictionary: None,
        workers: None,
        flush_emits_input: true,
    ),
];

/// Inputs for the round trips: empty, compressible and incompressible data,
/// each longer than an lz4 block (64 KiB) where not empty.
fn inputs() -> [Vec<u8>; 3] {
    [Vec::new(), text(100_000), noise(70_000, 2)]
}

#[test]
fn contexts_round_trip_at_any_chunk_size() {
    for codec in CODECS {
        for input in inputs() {
            let len = input.len();
            for chunk_sizes in [&[1][..], &[7], &[4096], &[len.max(1)], &[1, 7, 4096]] {
                let case = format!("{} of {len} bytes in chunks of {chunk_sizes:?}", codec.name);

                let compressed = drive(&mut *(codec.compressor)().unwrap(), &input, chunk_sizes)
                    .unwrap_or_else(|e| panic!("{case}: {e}"));
                assert!((codec.decompress)(&compressed).unwrap() == input, "{case}");

                // The decompression context reads its own format's stream as
                // the one-shot encoder writes it, too.
                for compressed in [compressed, (codec.compress)(&input).unwrap()] {
                    let output = drive(
                        &mut *(codec.decompressor)(None).unwrap(),
                        &compressed,
                        chunk_sizes,
                    )
                    .unwrap_or_else(|e| panic!("{case}: {e}"));
                    assert!(output == input, "{case}");
                }
            }
        }
    }
}

#[test]
fn flush_emits_all_input_so_far() {
    let input = text(10_000);
    let (first, second) = input.split_at(6_000);
    for codec in CODECS.iter().filter(|codec| codec.flush_emits_input) {
        let mut compressor = (codec.compressor)().unwrap();
        let mut decompressor = (codec.decompressor)(None).unwrap();

        let mut flushed = compressor.transform(first).unwrap();
        flushed.extend(compressor.flush().unwrap());
        let mut output = decompressor.transform(&flushed).unwrap();
        output.extend(decompressor.flush().unwrap());
        assert!(output == first, "{}", codec.name);

        let mut rest = compressor.transform(second).unwrap();
        rest.extend(compressor.finish().unwrap());
        output.extend(decompressor.transform(&rest).unwrap());
        output.extend(decompressor.finish().unwrap());
        assert!(output == input, "{}", codec.name);
    }
}

/// Check that every method of `ctx`, which is finished, fails with
/// [`ComprsError::StreamFinished`].
fn assert_finished(ctx: &mut BoxedContext, case: &str) {
    for result in [ctx.transform(b"more"), ctx.flush(), ctx.finish()] {
        assert!(
            matches!(result, Err(ComprsError::StreamFinished(_))),
            "{case}: {:?}",
            result.map(|output| output.len())
        );
    }
}

#[test]
fn contexts_cannot_be_used_after_finish() {
    let input = text(1000);
    for codec in CODECS {
        let mut compressor = (codec.compressor)().unwrap();
        let compressed = drive(&mut *compressor, &input, &[100]).unwrap();
        assert_finished(&mut compressor, &format!("{} compressor", codec.name));

        let mut decompressor = (codec.decompressor)(None).unwrap();
        assert!(drive(&mut *decompressor, &compressed, &[100]).unwrap() == input);
        assert_finished(&mut decompressor, &format!("{} decompressor", codec.name));

        // A finish that fails ends the stream as well.
        let mut decompressor = (codec.decompressor)(None).unwrap();
        decompressor
            .transform(&compressed[..compressed.len() / 2])
            .unwrap();
        assert!(
            decompressor.finish().is_err(),
            "{} decompressor",
            codec.name
        );
        assert_finished(
            &mut decompressor,
            &format!("truncated {} decompressor", codec.name),
        );
    }
}

/// Check that `ctx` holds less memory after `finish` than `during`, the
/// memory that it held while the stream ran: it releases its codec state.
fn assert_released(ctx: &BoxedContext, during: usize, case: &str) {
    let after = ctx.memory_usage();
    assert!(
        after < during,
        "{case}: {after} bytes after finish, {during} before"
    );
}

#[test]
fn contexts_release_their_state_on_finish() {
    let input = text(10_000);
    for codec in CODECS {
        let mut compressor = (codec.compressor)().unwrap();
        let mut compressed = compressor.transform(&input).unwrap();
        let during = compressor.memory_usage();
        compressed.extend(compressor.finish().unwrap());
        assert_released(&compressor, during, &format!("{} compressor", codec.name));

        let (head, tail) = compressed.split_at(compressed.len() / 2);
        let mut decompressor = (codec.decompressor)(None).unwrap();
        decompressor.transform(head).unwrap();
        let during = decompressor.memory_usage();
        decompressor.transform(tail).unwrap();
        decompressor.finish().unwrap();
        assert_released(
            &decompressor,
            during,
            &format!("{} decompressor", codec.name),
        );

        // Also when finish fails.
        let mut decompressor = (codec.decompressor)(None).unwrap();
        decompressor.transform(head).unwrap();
        let during = decompressor.memory_usage();
        assert!(
            decompressor.finish().is_err(),
            "{} decompressor",
            codec.name
        );
        assert_released(
            &decompressor,
            during,
            &format!("truncated {} decompressor", codec.name),
        );
    }
}

/// A compression context at a level, or at the default level for `None`.
type NewCompressor<T> = fn(Option<T>) -> Result<BoxedContext, ComprsError>;

/// Check that `new` accepts the levels in `valid` and the default level, and
/// rejects the levels in `invalid`.
fn check_levels<T: Copy + std::fmt::Display>(
    name: &str,
    new: NewCompressor<T>,
    valid: [T; 2],
    invalid: &[T],
) {
    let input = text(1000);
    for level in valid.map(Some).into_iter().chain([None]) {
        let mut ctx = new(level).unwrap_or_else(|e| panic!("{name}: {e}"));
        let compressed = drive(&mut *ctx, &input, &[input.len()]).unwrap();
        assert!(!compressed.is_empty(), "{name}");
    }
    for &level in invalid {
        assert!(
            matches!(new(Some(level)), Err(ComprsError::InvalidArg(_))),
            "{name} level {level}"
        );
    }
}

#[test]
fn compress_contexts_validate_the_level() {
    let unsigned: [(&str, NewCompressor<u32>, u32); 6] = [
        (
            "gzip",
            |level| boxed(gzip_stream::GzipCompressContext::new(level)),
            9,
        ),
        (
            "gzip with header",
            |level| {
                boxed(gzip_stream::GzipCompressContext::with_header(
                    level,
                    &header(),
                ))
            },
            9,
        ),
        (
            "deflate",
            |level| boxed(gzip_stream::DeflateCompressContext::new(level)),
            9,
        ),
        (
            "zlib",
            |level| boxed(gzip_stream::ZlibCompressContext::new(level)),
            9,
        ),
        (
            "brotli",
            |level| boxed(brotli_stream::CompressContext::new(level)),
            11,
        ),
        (
            "brotli dict",
            |level| boxed(brotli_stream::CompressDictContext::new(DICT, level)),
            11,
        ),
    ];
    for (name, new, max) in unsigned {
        check_levels(name, new, [0, max], &[max + 1, u32::MAX]);
    }

    let zstd: [(&str, NewCompressor<i32>); 3] = [
        ("zstd", |level| {
            boxed(zstd_stream::CompressContext::new(level))
        }),
        ("zstd dict", |level| {
            boxed(zstd_stream::CompressDictContext::new(DICT, level))
        }),
        ("zstd prepared dict", |level| {
            boxed(zstd_stream::CompressDictContext::with_prepared(
                &PREPARED, level, 0,
            ))
        }),
    ];
    for (name, new) in zstd {
        check_levels(
            name,
            new,
            [-131_072, 22],
            &[-131_073, 23, i32::MIN, i32::MAX],
        );
    }
}

#[test]
fn decompress_contexts_limit_the_output_of_a_single_chunk() {
    // 1 MiB of zeros: every format compresses it to a few kilobytes at most,
    // which one transform call expands.
    let original = vec![0u8; 1024 * 1024];
    let n = original.len();
    for codec in CODECS {
        let bomb = (codec.compress)(&original).unwrap();
        assert!(
            bomb.len() < n / 100,
            "{} of {} bytes",
            codec.name,
            bomb.len()
        );

        let mut ctx = (codec.decompressor)(Some(n as f64)).unwrap();
        assert!(
            drive(&mut *ctx, &bomb, &[bomb.len()]).unwrap() == original,
            "{}",
            codec.name
        );

        // The limit holds within each call: the transform call returns at
        // most n - 1 bytes, and the call that would exceed the limit fails.
        let mut ctx = (codec.decompressor)(Some((n - 1) as f64)).unwrap();
        let result = ctx.transform(&bomb).and_then(|output| {
            assert!(output.len() < n, "{}: {} bytes", codec.name, output.len());
            drive(&mut *ctx, &[], &[1])
        });
        assert!(
            matches!(result, Err(ComprsError::SizeLimit { limit, .. }) if limit == n - 1),
            "{}: {:?}",
            codec.name,
            result.map(|output| output.len())
        );
    }
}
