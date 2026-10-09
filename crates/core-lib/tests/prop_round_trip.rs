//! Property-based round trips of every format: random input, level, chunk
//! boundaries and dictionary, through the stream contexts and the one-shot
//! functions.

mod common;

use std::ops::RangeInclusive;

use common::{BoxedContext, boxed, drive};
use comprs_core::{
    ComprsError, brotli, brotli_stream, gzip, gzip_stream, lz4, lz4_stream, zstd, zstd_stream,
};
use proptest::prelude::*;
use proptest::sample::Index;

/// A one-shot encoder, called with the input, the dictionary and the level.
type Compress = fn(&[u8], &[u8], i32) -> Result<Vec<u8>, ComprsError>;

/// A one-shot decoder, called with the input and the dictionary.
type Decompress = fn(&[u8], &[u8]) -> Result<Vec<u8>, ComprsError>;

/// The functions of one format. Formats without a dictionary ignore it, and
/// lz4 ignores the level.
struct Codec {
    name: &'static str,
    levels: RangeInclusive<i32>,
    /// A compression context for the dictionary and the level.
    compressor: fn(&[u8], i32) -> Result<BoxedContext, ComprsError>,
    /// A decompression context for the dictionary, without an output limit.
    decompressor: fn(&[u8]) -> Result<BoxedContext, ComprsError>,
    compress: Compress,
    decompress: Decompress,
}

/// A gzip, deflate or brotli level, which those functions take unsigned.
fn unsigned(level: i32) -> Option<u32> {
    Some(u32::try_from(level).expect("levels of unsigned formats are not negative"))
}

const CODECS: &[Codec] = &[
    Codec {
        name: "gzip",
        levels: 0..=9,
        compressor: |_, level| boxed(gzip_stream::GzipCompressContext::new(unsigned(level))),
        decompressor: |_| boxed(gzip_stream::GzipDecompressContext::new(None)),
        compress: |data, _, level| gzip::compress(data, unsigned(level)),
        decompress: |data, _| gzip::decompress(data),
    },
    Codec {
        name: "deflate",
        levels: 0..=9,
        compressor: |_, level| boxed(gzip_stream::DeflateCompressContext::new(unsigned(level))),
        decompressor: |_| boxed(gzip_stream::DeflateDecompressContext::new(None)),
        compress: |data, _, level| gzip::deflate_compress(data, unsigned(level)),
        decompress: |data, _| gzip::deflate_decompress(data),
    },
    Codec {
        name: "brotli",
        levels: 0..=9,
        compressor: |_, level| boxed(brotli_stream::CompressContext::new(unsigned(level))),
        decompressor: |_| boxed(brotli_stream::DecompressContext::new(None)),
        compress: |data, _, level| brotli::compress(data, unsigned(level)),
        decompress: |data, _| brotli::decompress(data),
    },
    Codec {
        name: "brotli dict",
        levels: 0..=9,
        compressor: |dict, level| {
            boxed(brotli_stream::CompressDictContext::new(
                dict,
                unsigned(level),
            ))
        },
        decompressor: |dict| boxed(brotli_stream::DecompressDictContext::new(dict, None)),
        compress: |data, dict, level| brotli::compress_with_dict(data, dict, unsigned(level)),
        decompress: brotli::decompress_with_dict,
    },
    Codec {
        name: "zstd",
        levels: -5..=19,
        compressor: |_, level| boxed(zstd_stream::CompressContext::new(Some(level))),
        decompressor: |_| boxed(zstd_stream::DecompressContext::new(None)),
        compress: |data, _, level| zstd::compress(data, Some(level)),
        decompress: |data, _| zstd::decompress(data),
    },
    Codec {
        name: "zstd dict",
        levels: -5..=19,
        compressor: |dict, level| boxed(zstd_stream::CompressDictContext::new(dict, Some(level))),
        decompressor: |dict| boxed(zstd_stream::DecompressDictContext::new(dict, None)),
        compress: |data, dict, level| zstd::compress_with_dict(data, dict, Some(level)),
        decompress: zstd::decompress_with_dict,
    },
    Codec {
        name: "lz4",
        levels: 0..=0,
        compressor: |_, _| boxed(Ok(lz4_stream::CompressContext::new())),
        decompressor: |_| boxed(lz4_stream::DecompressContext::new(None)),
        compress: |data, _, _| lz4::compress(data),
        decompress: |data, _| lz4::decompress(data),
    },
];

impl Codec {
    /// The level that `index` picks from the format's levels.
    fn level(&self, index: Index) -> i32 {
        let count = self.levels.end() - self.levels.start() + 1;
        let offset = index.index(usize::try_from(count).expect("a non-empty level range"));
        self.levels.start() + i32::try_from(offset).expect("an offset into the level range")
    }
}

/// Largest generated input.
const MAX_INPUT: usize = 32 * 1024;

/// Largest generated dictionary.
const MAX_DICT: usize = 4 * 1024;

/// Words that text-like segments are made of.
const WORDS: &[&[u8]] = &[
    b"stream ", b"chunk ", b"frame ", b"block ", b"window ", b"level ", b"output ", b"\n",
];

/// A piece of input: noise, which no format compresses, or low-entropy
/// data of several kinds, which every format compresses.
fn segment() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        prop::collection::vec(any::<u8>(), 0..2048),
        (any::<u8>(), 0..4096usize).prop_map(|(byte, len)| vec![byte; len]),
        prop::collection::vec(prop::sample::select(WORDS), 0..512).prop_map(|words| words.concat()),
        (prop::collection::vec(any::<u8>(), 1..16), 0..256usize)
            .prop_map(|(pattern, count)| pattern.repeat(count)),
    ]
}

/// Up to `max_len` bytes made of up to `max_segments` segments.
fn data(max_segments: usize, max_len: usize) -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(segment(), 0..=max_segments).prop_map(move |segments| {
        let mut data = segments.concat();
        data.truncate(max_len);
        data
    })
}

/// The sizes of the chunks that a context is fed, used in turn.
fn chunk_sizes() -> impl Strategy<Value = Vec<usize>> {
    prop::collection::vec(1..4096usize, 1..8)
}

/// A dictionary, made like the input so that their text-like parts share
/// words. An empty dictionary stands for none.
fn dict() -> impl Strategy<Value = Vec<u8>> {
    data(3, MAX_DICT)
}

/// 64 cases per property; every case runs against every format.
fn config() -> ProptestConfig {
    ProptestConfig {
        cases: 64,
        ..ProptestConfig::default()
    }
}

proptest! {
    #![proptest_config(config())]

    /// Chunked context compression followed by one-shot decompression
    /// returns the input.
    #[test]
    fn chunked_compression_round_trips(
        input in data(24, MAX_INPUT),
        dict in dict(),
        level in any::<Index>(),
        chunk_sizes in chunk_sizes(),
    ) {
        for codec in CODECS {
            let level = codec.level(level);
            let case = format!(
                "{} at level {level} of {} bytes in chunks of {chunk_sizes:?}",
                codec.name,
                input.len()
            );
            let mut compressor = (codec.compressor)(&dict, level).unwrap();
            let compressed = drive(&mut *compressor, &input, &chunk_sizes)
                .unwrap_or_else(|e| panic!("{case}: {e}"));
            let output = (codec.decompress)(&compressed, &dict)
                .unwrap_or_else(|e| panic!("{case}: {e}"));
            prop_assert!(output == input, "{}", case);
        }
    }

    /// One-shot compression followed by chunked context decompression
    /// returns the input.
    #[test]
    fn chunked_decompression_round_trips(
        input in data(24, MAX_INPUT),
        dict in dict(),
        level in any::<Index>(),
        chunk_sizes in chunk_sizes(),
    ) {
        for codec in CODECS {
            let level = codec.level(level);
            let case = format!(
                "{} at level {level} of {} bytes in chunks of {chunk_sizes:?}",
                codec.name,
                input.len()
            );
            let compressed = (codec.compress)(&input, &dict, level)
                .unwrap_or_else(|e| panic!("{case}: {e}"));
            let mut decompressor = (codec.decompressor)(&dict).unwrap();
            let output = drive(&mut *decompressor, &compressed, &chunk_sizes)
                .unwrap_or_else(|e| panic!("{case}: {e}"));
            prop_assert!(output == input, "{}", case);
        }
    }

    /// One-shot and chunked context decompression fail on every strict,
    /// non-empty prefix of a stream, as the one-shot encoder and the stream
    /// context write it.
    ///
    /// Both write a single stream or frame, and every format marks where it
    /// ends: the gzip trailer, the final deflate or brotli block, the last
    /// zstd block, the lz4 end mark and content checksum. The one-shot
    /// decoders and the decompression contexts reject input that stops
    /// before that end, so no prefix counts as complete. Data after the
    /// end, which the one-shot brotli and deflate decoders ignore, cannot
    /// occur in a prefix.
    #[test]
    fn truncated_streams_fail(
        input in data(24, MAX_INPUT),
        dict in dict(),
        level in any::<Index>(),
        chunk_sizes in chunk_sizes(),
        cut in any::<Index>(),
    ) {
        for codec in CODECS {
            let level = codec.level(level);
            let case = format!("{} at level {level} of {} bytes", codec.name, input.len());
            let one_shot = (codec.compress)(&input, &dict, level)
                .unwrap_or_else(|e| panic!("{case}: {e}"));
            let mut compressor = (codec.compressor)(&dict, level).unwrap();
            let streamed = drive(&mut *compressor, &input, &chunk_sizes)
                .unwrap_or_else(|e| panic!("{case}: {e}"));
            for (encoder, compressed) in [("one-shot", one_shot), ("stream", streamed)] {
                // A prefix of 1 to len - 1 bytes.
                let Some(last) = compressed.len().checked_sub(1).filter(|&n| n > 0) else {
                    continue;
                };
                let cut = 1 + cut.index(last);
                let prefix = &compressed[..cut];
                let mut decompressor = (codec.decompressor)(&dict).unwrap();
                for (decoder, result) in [
                    ("one-shot", (codec.decompress)(prefix, &dict)),
                    ("context", drive(&mut *decompressor, prefix, &chunk_sizes)),
                ] {
                    prop_assert!(
                        result.is_err(),
                        "{} {} output cut to {} of {} bytes decoded by the {} decoder to {} bytes",
                        case,
                        encoder,
                        cut,
                        compressed.len(),
                        decoder,
                        result.map_or(0, |output| output.len())
                    );
                }
            }
        }
    }
}
