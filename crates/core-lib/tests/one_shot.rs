//! The one-shot functions of every format, driven through their public API.

mod common;

use common::{Context, drive, noise, text};
use comprs_core::detect::{self, Format as Detected};
use comprs_core::{
    ComprsError, brotli, brotli_stream, gzip, gzip_stream, lz4, lz4_stream, zstd, zstd_stream,
};

const DICT: &[u8] = b"stream chunk frame block window level output, a dictionary";

type Encode = fn(&[u8]) -> Result<Vec<u8>, ComprsError>;
type Decode = fn(&[u8]) -> Result<Vec<u8>, ComprsError>;
type DecodeWithCapacity = fn(&[u8], usize) -> Result<Vec<u8>, ComprsError>;

/// What a decoder does with the data after the first stream or frame.
#[derive(Clone, Copy, Debug, PartialEq)]
enum After {
    /// It decodes further streams and rejects anything else.
    Decoded,
    /// It ignores the data.
    Ignored,
}

/// The one-shot functions of one format.
struct Codec {
    name: &'static str,
    /// The format name that [`ComprsError::Truncated`] holds.
    truncated: &'static str,
    /// The format that `detect` reports, or `None` for the dictionary
    /// formats, which it cannot decode.
    detected: Option<Detected>,
    /// The one-shot encoder and the stream context, which may write the
    /// format differently.
    encoders: [Encode; 2],
    decompress: Decode,
    decompress_with_capacity: DecodeWithCapacity,
    after_the_stream: After,
}

/// Compress `data` with a stream context, in chunks of 4 KiB.
fn stream<C: Context>(ctx: Result<C, ComprsError>, data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    drive(&mut ctx?, data, &[4096])
}

const CODECS: &[Codec] = &[
    Codec {
        name: "gzip",
        truncated: "gzip",
        detected: Some(Detected::Gzip),
        encoders: [
            |data| gzip::compress(data, None),
            |data| stream(gzip_stream::GzipCompressContext::new(None), data),
        ],
        decompress: gzip::decompress,
        decompress_with_capacity: gzip::decompress_with_capacity,
        after_the_stream: After::Decoded,
    },
    Codec {
        name: "deflate",
        truncated: "deflate",
        detected: Some(Detected::Unknown),
        encoders: [
            |data| gzip::deflate_compress(data, None),
            |data| stream(gzip_stream::DeflateCompressContext::new(None), data),
        ],
        decompress: gzip::deflate_decompress,
        decompress_with_capacity: gzip::deflate_decompress_with_capacity,
        after_the_stream: After::Ignored,
    },
    Codec {
        name: "brotli",
        truncated: "brotli",
        detected: Some(Detected::Brotli),
        encoders: [
            |data| brotli::compress(data, None),
            |data| stream(brotli_stream::CompressContext::new(None), data),
        ],
        decompress: brotli::decompress,
        decompress_with_capacity: brotli::decompress_with_capacity,
        after_the_stream: After::Ignored,
    },
    Codec {
        name: "brotli dict",
        truncated: "brotli",
        detected: None,
        encoders: [
            |data| brotli::compress_with_dict(data, DICT, None),
            |data| stream(brotli_stream::CompressDictContext::new(DICT, None), data),
        ],
        decompress: |data| brotli::decompress_with_dict(data, DICT),
        decompress_with_capacity: |data, capacity| {
            brotli::decompress_with_dict_with_capacity(data, DICT, capacity)
        },
        after_the_stream: After::Ignored,
    },
    Codec {
        name: "zstd",
        truncated: "zstd",
        detected: Some(Detected::Zstd),
        encoders: [
            |data| zstd::compress(data, None),
            |data| stream(zstd_stream::CompressContext::new(None), data),
        ],
        decompress: zstd::decompress,
        decompress_with_capacity: zstd::decompress_with_capacity,
        after_the_stream: After::Decoded,
    },
    Codec {
        name: "zstd dict",
        truncated: "zstd",
        detected: None,
        encoders: [
            |data| zstd::compress_with_dict(data, DICT, None),
            |data| stream(zstd_stream::CompressDictContext::new(DICT, None), data),
        ],
        decompress: |data| zstd::decompress_with_dict(data, DICT),
        decompress_with_capacity: |data, capacity| {
            zstd::decompress_with_dict_with_capacity(data, DICT, capacity)
        },
        after_the_stream: After::Decoded,
    },
    Codec {
        name: "lz4",
        truncated: "lz4",
        detected: Some(Detected::Lz4),
        encoders: [lz4::compress, |data| {
            stream(Ok(lz4_stream::CompressContext::new()), data)
        }],
        decompress: lz4::decompress,
        decompress_with_capacity: lz4::decompress_with_capacity,
        after_the_stream: After::Decoded,
    },
];

/// Inputs that compress well, not at all, and extremely well.
fn inputs() -> [Vec<u8>; 3] {
    [text(50_000), noise(20_000, 3), vec![0; 1024 * 1024]]
}

#[test]
fn with_capacity_accepts_exactly_the_output_size() {
    for codec in CODECS {
        for input in inputs() {
            let n = input.len();
            for (encoder, encode) in codec.encoders.iter().enumerate() {
                let case = format!("{} encoder {encoder}, {n} bytes", codec.name);
                let compressed = encode(&input).unwrap();
                let decode = codec.decompress_with_capacity;
                assert!(decode(&compressed, n).unwrap() == input, "{case}");
                for capacity in [n - 1, 0] {
                    let result = decode(&compressed, capacity);
                    assert!(
                        matches!(result, Err(ComprsError::SizeLimit { limit, .. }) if limit == capacity),
                        "{case} into {capacity} bytes: {:?}",
                        result.map(|output| output.len())
                    );
                }
            }
        }
    }
}

#[test]
fn empty_input() {
    for codec in CODECS {
        // Empty data compresses to a stream that decodes to nothing...
        for encode in codec.encoders {
            let compressed = encode(&[]).unwrap();
            assert!(!compressed.is_empty(), "{}", codec.name);
            assert_eq!(
                (codec.decompress)(&compressed).unwrap(),
                b"",
                "{}",
                codec.name
            );
            assert_eq!(
                (codec.decompress_with_capacity)(&compressed, 0).unwrap(),
                b"",
                "{}",
                codec.name
            );
        }
        // ...while empty input is not a stream at all.
        for result in [
            (codec.decompress)(&[]),
            (codec.decompress_with_capacity)(&[], 1024),
        ] {
            assert!(
                matches!(result, Err(ComprsError::Truncated(format)) if format == codec.truncated),
                "{}: {:?}",
                codec.name,
                result.map(|output| output.len())
            );
        }
    }
}

#[test]
fn truncated_input_fails() {
    let input = text(20_000);
    for codec in CODECS {
        for encode in codec.encoders {
            let compressed = encode(&input).unwrap();
            let len = compressed.len();
            for cut in [len / 2].into_iter().chain(len - 8..len) {
                for result in [
                    (codec.decompress)(&compressed[..cut]),
                    (codec.decompress_with_capacity)(&compressed[..cut], input.len()),
                ] {
                    assert!(
                        result.is_err(),
                        "{} cut to {cut} of {len} bytes decoded to {} bytes",
                        codec.name,
                        result.map_or(0, |output| output.len())
                    );
                }
            }
        }
    }
}

#[test]
fn data_after_the_stream_follows_the_format() {
    let first = text(3000);
    let second = noise(1000, 4);
    for codec in CODECS {
        let compressed = (codec.encoders[0])(&first).unwrap();
        let concatenated = [compressed.clone(), (codec.encoders[1])(&second).unwrap()].concat();
        let garbage = [&compressed[..], b"trailing garbage"].concat();

        let expected = [&first[..], &second[..]].concat();
        let decoded = (codec.decompress)(&concatenated).unwrap();
        let with_garbage = (codec.decompress)(&garbage);
        match codec.after_the_stream {
            After::Decoded => {
                assert!(decoded == expected, "{}", codec.name);
                assert!(with_garbage.is_err(), "{}", codec.name);
            }
            After::Ignored => {
                assert!(decoded == first, "{}", codec.name);
                assert!(with_garbage.unwrap() == first, "{}", codec.name);
            }
        }
    }
}

#[test]
fn zstd_level_zero_is_the_default_level() {
    let data = text(50_000);
    let default = zstd::compress(&data, None).unwrap();
    assert_eq!(zstd::compress(&data, Some(0)).unwrap(), default);
    assert_eq!(
        zstd::compress(&data, Some(zstd::DEFAULT_LEVEL)).unwrap(),
        default
    );
    // Level 3 is the default, so another level must differ from it.
    assert_ne!(zstd::compress(&data, Some(1)).unwrap(), default);

    let default = zstd::compress_with_dict(&data, DICT, None).unwrap();
    assert_eq!(
        zstd::compress_with_dict(&data, DICT, Some(0)).unwrap(),
        default
    );
    assert_ne!(
        zstd::compress_with_dict(&data, DICT, Some(1)).unwrap(),
        default
    );

    let stream_at = |level| stream(zstd_stream::CompressContext::new(level), &data).unwrap();
    assert_eq!(stream_at(Some(0)), stream_at(None));
    assert_ne!(stream_at(Some(1)), stream_at(None));
}

#[test]
fn detect_routes_every_format() {
    let input = text(10_000);
    for codec in CODECS {
        let Some(detected) = codec.detected else {
            continue;
        };
        for encode in codec.encoders {
            let compressed = encode(&input).unwrap();
            assert_eq!(detect::detect(&compressed), detected, "{}", codec.name);
            let results = [
                detect::decompress(&compressed),
                detect::decompress_with_capacity(&compressed, input.len()),
            ];
            for result in results {
                match detected {
                    // Raw deflate has no header to recognize.
                    Detected::Unknown => assert!(
                        matches!(result, Err(ComprsError::UnknownFormat(_))),
                        "{}",
                        codec.name
                    ),
                    _ => assert!(result.unwrap() == input, "{}", codec.name),
                }
            }
        }
    }
}
