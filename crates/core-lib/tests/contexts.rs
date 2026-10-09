//! The stream contexts of every format, driven through their public API.

mod common;

use common::{BoxedContext, boxed, drive, noise, text};
use comprs_core::{
    ComprsError, brotli, brotli_stream, gzip, gzip_stream, lz4, lz4_stream, zstd, zstd_stream,
};

const DICT: &[u8] = b"stream chunk frame block window level output, a dictionary";

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
    /// context buffers its input until `finish`, and the lz4 decompression
    /// context decodes only complete frames.
    flush_emits_input: bool,
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
        name: "lz4",
        compressor: || boxed(Ok(lz4_stream::CompressContext::new())),
        decompressor: |limit| boxed(lz4_stream::DecompressContext::new(limit)),
        compress: lz4::compress,
        decompress: lz4::decompress,
        flush_emits_input: false,
    },
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
    let unsigned: [(&str, NewCompressor<u32>, u32); 4] = [
        (
            "gzip",
            |level| boxed(gzip_stream::GzipCompressContext::new(level)),
            9,
        ),
        (
            "deflate",
            |level| boxed(gzip_stream::DeflateCompressContext::new(level)),
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

    let zstd: [(&str, NewCompressor<i32>); 2] = [
        ("zstd", |level| {
            boxed(zstd_stream::CompressContext::new(level))
        }),
        ("zstd dict", |level| {
            boxed(zstd_stream::CompressDictContext::new(DICT, level))
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
