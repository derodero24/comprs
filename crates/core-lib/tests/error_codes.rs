//! The codes of the errors that every format reports, through the public API.

mod common;

use common::{BoxedContext, boxed, text};
use comprs_core::gzip::{FlateWrapper, GzipHeaderOptions};
use comprs_core::{
    ComprsError, ERROR_CODES, MAX_DECOMPRESSED_SIZE, brotli, brotli_stream, detect, gzip,
    gzip_stream, lz4, lz4_stream, zstd, zstd_stream,
};

const INVALID_ARG: &str = "ERR_COMPRS_INVALID_ARG";
const UNKNOWN_FORMAT: &str = "ERR_COMPRS_UNKNOWN_FORMAT";
const CORRUPT_DATA: &str = "ERR_COMPRS_CORRUPT_DATA";
const TRUNCATED: &str = "ERR_COMPRS_TRUNCATED";
const SIZE_LIMIT: &str = "ERR_COMPRS_SIZE_LIMIT";
const STREAM_FINISHED: &str = "ERR_COMPRS_STREAM_FINISHED";

/// The code of the error that `result` holds.
#[track_caller]
fn code<T>(result: Result<T, ComprsError>) -> &'static str {
    let Err(error) = result else {
        panic!("succeeded instead of failing");
    };
    assert!(ERROR_CODES.contains(&error.code()), "{error:?}");
    error.code()
}

/// Decode the whole of `input` with `ctx` in one chunk.
fn decode(mut ctx: BoxedContext, input: &[u8]) -> Result<Vec<u8>, ComprsError> {
    let mut output = ctx.transform(input)?;
    output.extend(ctx.finish()?);
    Ok(output)
}

/// A one-shot decoder, called with an output limit, which the functions
/// without a limit ignore.
type Decoder = fn(&[u8], usize) -> Result<Vec<u8>, ComprsError>;

/// Makes input that the decoders reject as invalid from the output of
/// `compress`.
type Corruption = fn(compressed: &[u8]) -> Vec<u8>;

/// The functions of one format.
struct Codec {
    name: &'static str,
    compress: fn(&[u8]) -> Result<Vec<u8>, ComprsError>,
    decoders: &'static [Decoder],
    compressor: fn() -> Result<BoxedContext, ComprsError>,
    decompressor: fn(Option<f64>) -> Result<BoxedContext, ComprsError>,
    /// Inputs that the decoders reject as invalid.
    corrupt: &'static [Corruption],
    /// The calls that take a compression level, each with one out of range.
    /// lz4 takes no level.
    invalid_levels: &'static [fn() -> Result<(), ComprsError>],
    /// The code of the one-shot decoders for input cut inside the
    /// compressed data.
    cut: &'static str,
    /// The code of the decompression context for input cut inside the
    /// compressed data.
    cut_stream: &'static str,
}

/// A zstd frame whose only block has the reserved block type. It declares
/// no content size, so the one-shot decoders decode it with the streaming
/// decoder.
const CORRUPT_ZSTD: &[u8] = &[
    0x28, 0xB5, 0x2F, 0xFD, // magic number
    0x00, 0x00, // frame header: no content size, 1 KiB window
    0x07, 0x00, 0x00, // block header: last block, reserved type
];

/// A zstd frame that declares a content size of 10 bytes but holds 5. The
/// one-shot decoders trust the declared size and decode the frame straight
/// into a buffer of that size.
const CORRUPT_ZSTD_WITH_SIZE: &[u8] = &[
    0x28, 0xB5, 0x2F, 0xFD, // magic number
    0x20, 0x0A, // frame header: single segment, content size 10
    0x29, 0x00, 0x00, // block header: last block, raw, 5 bytes
    b'h', b'e', b'l', b'l', b'o',
];

/// The gzip header that the compressor of the "gzip strict" codec writes.
fn header() -> GzipHeaderOptions {
    GzipHeaderOptions {
        filename: Some("data.txt".to_string()),
        mtime: Some(1_700_000_000),
    }
}

/// A strict decompression context for the format of `wrapper`.
fn strict(wrapper: FlateWrapper, limit: Option<f64>) -> Result<BoxedContext, ComprsError> {
    boxed(gzip_stream::StrictDecompressContext::new(wrapper, limit))
}

/// `compressed` with the byte at `index` changed so that the deflate block
/// that starts there has the reserved block type.
fn reserved_deflate_block(compressed: &[u8], index: usize) -> Vec<u8> {
    let mut corrupt = compressed.to_vec();
    corrupt[index] = 0xFF;
    corrupt
}

const CODECS: &[Codec] = &[
    Codec {
        name: "zstd",
        compress: |data| zstd::compress(data, None),
        decoders: &[
            |data, _| zstd::decompress(data),
            zstd::decompress_with_capacity,
        ],
        compressor: || boxed(zstd_stream::CompressContext::new(None)),
        decompressor: |limit| boxed(zstd_stream::DecompressContext::new(limit)),
        corrupt: &[
            |_| CORRUPT_ZSTD.to_vec(),
            |_| CORRUPT_ZSTD_WITH_SIZE.to_vec(),
        ],
        invalid_levels: &[
            || zstd::compress(b"data", Some(23)).map(drop),
            || zstd_stream::CompressContext::new(Some(23)).map(drop),
        ],
        cut: TRUNCATED,
        cut_stream: TRUNCATED,
    },
    Codec {
        name: "gzip",
        compress: |data| gzip::compress(data, None),
        decoders: &[
            |data, _| gzip::decompress(data),
            gzip::decompress_with_capacity,
        ],
        compressor: || boxed(gzip_stream::GzipCompressContext::new(None)),
        decompressor: |limit| boxed(gzip_stream::GzipDecompressContext::new(limit)),
        // The deflate data follows the 10-byte header.
        corrupt: &[|compressed| reserved_deflate_block(compressed, 10)],
        invalid_levels: &[
            || gzip::compress(b"data", Some(10)).map(drop),
            || {
                let header = gzip::GzipHeaderOptions {
                    filename: None,
                    mtime: None,
                };
                gzip::compress_with_header(b"data", &header, Some(10)).map(drop)
            },
            || gzip_stream::GzipCompressContext::new(Some(10)).map(drop),
        ],
        // The known limit of the gzip decoders, which use flate2's
        // MultiGzDecoder: input that ends inside a member fails with the
        // error of corrupt data, so it is classified as corrupt.
        cut: CORRUPT_DATA,
        cut_stream: CORRUPT_DATA,
    },
    Codec {
        name: "deflate",
        compress: |data| gzip::deflate_compress(data, None),
        decoders: &[
            |data, _| gzip::deflate_decompress(data),
            gzip::deflate_decompress_with_capacity,
        ],
        compressor: || boxed(gzip_stream::DeflateCompressContext::new(None)),
        decompressor: |limit| boxed(gzip_stream::DeflateDecompressContext::new(limit)),
        corrupt: &[|compressed| reserved_deflate_block(compressed, 0)],
        invalid_levels: &[
            || gzip::deflate_compress(b"data", Some(10)).map(drop),
            || gzip_stream::DeflateCompressContext::new(Some(10)).map(drop),
        ],
        cut: TRUNCATED,
        cut_stream: TRUNCATED,
    },
    Codec {
        name: "gzip strict",
        compress: |data| gzip::compress(data, None),
        decoders: &[
            |data, _| gzip::decompress_strict(data, FlateWrapper::Gzip, MAX_DECOMPRESSED_SIZE),
            |data, limit| gzip::decompress_strict(data, FlateWrapper::Gzip, limit),
        ],
        compressor: || {
            boxed(gzip_stream::GzipCompressContext::with_header(
                None,
                &header(),
            ))
        },
        decompressor: |limit| strict(FlateWrapper::Gzip, limit),
        corrupt: &[|compressed| reserved_deflate_block(compressed, 10)],
        invalid_levels: &[|| {
            gzip_stream::GzipCompressContext::with_header(Some(10), &header()).map(drop)
        }],
        cut: TRUNCATED,
        cut_stream: TRUNCATED,
    },
    Codec {
        name: "zlib",
        compress: |data| gzip::zlib_compress(data, None),
        decoders: &[
            |data, _| gzip::decompress_strict(data, FlateWrapper::Zlib, MAX_DECOMPRESSED_SIZE),
            |data, limit| gzip::decompress_strict(data, FlateWrapper::Zlib, limit),
        ],
        compressor: || boxed(gzip_stream::ZlibCompressContext::new(None)),
        decompressor: |limit| strict(FlateWrapper::Zlib, limit),
        // The deflate data follows the 2-byte header.
        corrupt: &[|compressed| reserved_deflate_block(compressed, 2)],
        invalid_levels: &[
            || gzip::zlib_compress(b"data", Some(10)).map(drop),
            || gzip_stream::ZlibCompressContext::new(Some(10)).map(drop),
        ],
        cut: TRUNCATED,
        cut_stream: TRUNCATED,
    },
    Codec {
        name: "deflate-raw strict",
        compress: |data| gzip::deflate_compress(data, None),
        decoders: &[
            |data, _| gzip::decompress_strict(data, FlateWrapper::Raw, MAX_DECOMPRESSED_SIZE),
            |data, limit| gzip::decompress_strict(data, FlateWrapper::Raw, limit),
        ],
        compressor: || boxed(gzip_stream::DeflateCompressContext::new(None)),
        decompressor: |limit| strict(FlateWrapper::Raw, limit),
        corrupt: &[|compressed| reserved_deflate_block(compressed, 0)],
        // The "deflate" codec checks the levels of the raw deflate encoders.
        invalid_levels: &[],
        cut: TRUNCATED,
        cut_stream: TRUNCATED,
    },
    Codec {
        name: "brotli",
        compress: |data| brotli::compress(data, None),
        decoders: &[
            |data, _| brotli::decompress(data),
            brotli::decompress_with_capacity,
        ],
        compressor: || boxed(brotli_stream::CompressContext::new(None)),
        decompressor: |limit| boxed(brotli_stream::DecompressContext::new(limit)),
        // 0xFF is a valid stream header (WBITS 24) followed by an empty last
        // meta-block (ISLAST, ISLASTEMPTY); the decoders reject it because
        // the padding bits after that meta-block are not zero.
        corrupt: &[|_| vec![0xFF; 16]],
        invalid_levels: &[
            || brotli::compress(b"data", Some(12)).map(drop),
            || brotli::compress_with_dict(b"data", b"dictionary", Some(12)).map(drop),
            || brotli_stream::CompressContext::new(Some(12)).map(drop),
            || brotli_stream::CompressDictContext::new(b"dictionary", Some(12)).map(drop),
        ],
        // The one-shot decoders report a cut stream as invalid data
        // ("Invalid Data") and keep that message, so it is classified as
        // corrupt.
        cut: CORRUPT_DATA,
        cut_stream: TRUNCATED,
    },
    Codec {
        name: "lz4",
        compress: lz4::compress,
        decoders: &[
            |data, _| lz4::decompress(data),
            lz4::decompress_with_capacity,
        ],
        compressor: || boxed(Ok(lz4_stream::CompressContext::new())),
        decompressor: |limit| boxed(lz4_stream::DecompressContext::new(limit)),
        // The last literal of the last block, which the content checksum
        // covers.
        corrupt: &[|compressed| {
            let mut corrupt = compressed.to_vec();
            corrupt[compressed.len() - 9] ^= 0x01;
            corrupt
        }],
        invalid_levels: &[],
        cut: TRUNCATED,
        cut_stream: TRUNCATED,
    },
];

#[test]
fn corrupt_data() {
    let input = text(20_000);
    for codec in CODECS {
        let name = codec.name;
        let compressed = (codec.compress)(&input).unwrap();
        for corrupt in codec.corrupt {
            let corrupt = corrupt(&compressed);
            for decoder in codec.decoders {
                let result = decoder(&corrupt, input.len());
                assert_eq!(code(result), CORRUPT_DATA, "{name}: {corrupt:x?}");
            }
            let ctx = (codec.decompressor)(None).unwrap();
            let result = decode(ctx, &corrupt);
            assert_eq!(code(result), CORRUPT_DATA, "{name}: {corrupt:x?}");
        }
    }
}

#[test]
fn data_after_the_stream() {
    let data = b"data";
    for codec in CODECS {
        let name = codec.name;
        let compressed = (codec.compress)(data).unwrap();
        let input = [&compressed[..], b"trailing garbage"].concat();
        // The deflate and brotli one-shot decoders ignore data after the
        // stream; the decompression contexts of every format reject it.
        if !matches!(name, "deflate" | "brotli") {
            for decoder in codec.decoders {
                assert_eq!(code(decoder(&input, data.len())), CORRUPT_DATA, "{name}");
            }
        }
        let ctx = (codec.decompressor)(None).unwrap();
        assert_eq!(code(decode(ctx, &input)), CORRUPT_DATA, "{name}");
    }
}

#[test]
fn truncated_input() {
    let input = text(20_000);
    for codec in CODECS {
        let name = codec.name;
        let compressed = (codec.compress)(&input).unwrap();
        let len = compressed.len();
        for cut in [len / 2, len - 1] {
            let cut_input = &compressed[..cut];
            for decoder in codec.decoders {
                let result = decoder(cut_input, input.len());
                assert_eq!(code(result), codec.cut, "{name} cut to {cut} bytes");
            }
            let ctx = (codec.decompressor)(None).unwrap();
            let result = decode(ctx, cut_input);
            assert_eq!(code(result), codec.cut_stream, "{name} cut to {cut} bytes");
        }

        // Empty input is truncated for every decoder.
        for decoder in codec.decoders {
            assert_eq!(code(decoder(&[], input.len())), TRUNCATED, "{name}");
        }
        let ctx = (codec.decompressor)(None).unwrap();
        assert_eq!(code(decode(ctx, &[])), TRUNCATED, "{name}");
    }

    // The gzip decompression context tells a cut inside the header.
    let compressed = gzip::compress(&input, None).unwrap();
    let ctx = boxed(gzip_stream::GzipDecompressContext::new(None)).unwrap();
    assert_eq!(code(decode(ctx, &compressed[..5])), TRUNCATED);
}

#[test]
fn size_limit() {
    let input = text(20_000);
    let limit = input.len() - 1;
    for codec in CODECS {
        let name = codec.name;
        let compressed = (codec.compress)(&input).unwrap();
        // The decoder that takes a limit.
        let decoder = codec.decoders[1];
        assert_eq!(code(decoder(&compressed, limit)), SIZE_LIMIT, "{name}");
        let ctx = (codec.decompressor)(Some(limit as f64)).unwrap();
        assert_eq!(code(decode(ctx, &compressed)), SIZE_LIMIT, "{name}");
    }
}

#[test]
fn invalid_arguments() {
    for codec in CODECS {
        let name = codec.name;
        for call in codec.invalid_levels {
            assert_eq!(code(call()), INVALID_ARG, "{name}");
        }
        for limit in [-1.0, 0.5, f64::NAN] {
            let result = (codec.decompressor)(Some(limit));
            assert_eq!(code(result), INVALID_ARG, "{name} with a limit of {limit}");
        }
    }
    assert_eq!(code(zstd::train_dictionary(&[], usize::MAX)), INVALID_ARG);
    assert_eq!(code(comprs_core::validate_capacity(-1.0)), INVALID_ARG);

    // gzip::read_header keeps the category of its error, which the bindings
    // report as an invalid argument.
    assert_eq!(code(gzip::read_header(b"hello world")), INVALID_ARG);
}

#[test]
fn unknown_format() {
    let deflate = gzip::deflate_compress(b"raw deflate has no header", None).unwrap();
    for input in [&b"hello world"[..], &[], &deflate] {
        assert_eq!(code(detect::decompress(input)), UNKNOWN_FORMAT, "{input:?}");
        let result = detect::decompress_with_capacity(input, 1024);
        assert_eq!(code(result), UNKNOWN_FORMAT, "{input:?}");
    }

    // The first half of a brotli stream, which the brotli probe of detection
    // accepts, but which does not decode.
    let lines: Vec<u8> = (0..5000)
        .flat_map(|i| format!("line {i}: comprs keeps the codes of its errors\n").into_bytes())
        .collect();
    let brotli = brotli::compress(&lines, None).unwrap();
    let cut = &brotli[..brotli.len() / 2];
    assert_eq!(detect::detect(cut), detect::Format::Brotli);
    assert_eq!(code(detect::decompress(cut)), UNKNOWN_FORMAT);
    let result = detect::decompress_with_capacity(cut, lines.len());
    assert_eq!(code(result), UNKNOWN_FORMAT);
}

#[test]
fn strict_contexts_keep_the_code_of_their_error() {
    let input = text(20_000);
    for name in ["gzip strict", "zlib", "deflate-raw strict"] {
        let Some(codec) = CODECS.iter().find(|codec| codec.name == name) else {
            panic!("no codec named {name}");
        };
        let compressed = (codec.compress)(&input).unwrap();
        let cases = [
            (
                [&compressed[..], b"trailing garbage"].concat(),
                None,
                CORRUPT_DATA,
            ),
            ((codec.corrupt[0])(&compressed), None, CORRUPT_DATA),
            (compressed, Some((input.len() - 1) as f64), SIZE_LIMIT),
        ];
        for (data, limit, expected) in cases {
            let mut ctx = (codec.decompressor)(limit).unwrap();
            assert_eq!(code(ctx.transform(&data)), expected, "{name}");
            // The later calls report the error again, until finish() ends
            // the stream.
            assert_eq!(code(ctx.transform(b"x")), expected, "{name}");
            assert_eq!(code(ctx.flush()), expected, "{name}");
            assert_eq!(code(ctx.finish()), expected, "{name}");
            assert_eq!(code(ctx.transform(b"x")), STREAM_FINISHED, "{name}");
        }
    }
}

#[test]
fn stream_finished() {
    for codec in CODECS {
        let name = codec.name;
        let mut compressor = (codec.compressor)().unwrap();
        compressor.finish().unwrap();
        assert_eq!(code(compressor.finish()), STREAM_FINISHED, "{name}");
        assert_eq!(code(compressor.transform(b"x")), STREAM_FINISHED, "{name}");

        let compressed = (codec.compress)(b"data").unwrap();
        let mut decompressor = (codec.decompressor)(None).unwrap();
        decompressor.transform(&compressed).unwrap();
        decompressor.finish().unwrap();
        assert_eq!(code(decompressor.finish()), STREAM_FINISHED, "{name}");
        assert_eq!(code(decompressor.flush()), STREAM_FINISHED, "{name}");
    }
}
