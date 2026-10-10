//! Brotli compression and decompression.

use std::io::Write;

use crate::brotli_stream::{CountingAlloc, End, compressor};
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

/// Longest input, 8 MiB, that [`compress_with_dict`] compresses with a
/// custom dictionary; it compresses a longer one with neither dictionary.
///
/// brotli 9.0.0's encoder puts a custom dictionary at the start of its ring
/// buffer, which holds 2^([`LG_WINDOW_SIZE`] + 1) bytes at every quality
/// (the blocks of the encoder, of at most 2^18 bytes, are smaller than its
/// window), and cuts every match whose source crosses the end of the
/// dictionary there (#623). It tells where a source starts by its position
/// in the ring buffer, so once the input has wrapped around the buffer, it
/// also cuts the matches whose source crosses that position on a later lap,
/// and panics on a cut that leaves one byte, which it cannot encode (#703).
/// The source of such a match runs past the first
/// 2^([`LG_WINDOW_SIZE`] + 1) bytes of input, so an input of at most this
/// many bytes has none. wasm32 aborts on the panic, so it cannot be caught
/// there, and the native build would encode the input twice.
pub const DICT_INPUT_LIMIT: usize = 1 << (LG_WINDOW_SIZE + 1);

/// Reject a stream that uses the Large Window Brotli extension.
///
/// Such a stream starts with the seven bits 0010001 (`0x11` in the low bits
/// of the first byte), a window size code that RFC 7932 leaves invalid; the
/// next byte then picks a window of up to 1 GiB. brotli-decompressor accepts
/// these streams unless told otherwise, and allocates its ring buffer at the
/// window size whatever the output limit: 12 bytes of input made it allocate
/// 512 MiB. Every decoder state here turns `large_window` off; the one-shot
/// functions also check the header up front, so that they report this
/// error rather than "Invalid Data". RFC 7932 decoders, Node's zlib among
/// them, reject the same streams.
pub(crate) fn reject_large_window(data: &[u8], context: &'static str) -> Result<(), ComprsError> {
    if data.first().is_some_and(|&byte| byte & 0x7f == 0x11) {
        return Err(ComprsError::Corrupt {
            context,
            source: "large-window brotli streams are not supported".into(),
        });
    }
    Ok(())
}

/// Compress data using Brotli.
///
/// The encoder recycles its ring buffer, as the streams do (see
/// `brotli_stream::RING_BUFFER`).
pub fn compress(data: &[u8], quality: Option<u32>) -> Result<Vec<u8>, ComprsError> {
    let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;
    let output = Vec::with_capacity(data.len());
    let mut compressor = compressor(output, CountingAlloc::for_encoder(), quality);
    compressor
        .write_all(data)
        .map_err(|e| ComprsError::Operation {
            context: "brotli compress",
            source: e.into(),
        })?;
    // into_inner flushes the compressor and ends the stream.
    Ok(crate::finish_output(compressor.into_inner()))
}

/// Decompress Brotli-compressed data.
///
/// The output is limited to [`crate::MAX_DECOMPRESSED_SIZE`] bytes. Data
/// after the end of the brotli stream is ignored.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    decompress_with_capacity(data, crate::MAX_DECOMPRESSED_SIZE)
}

/// Decompress Brotli-compressed data with explicit capacity.
///
/// `capacity` limits the output size; the output buffer grows with the
/// decompressed data instead of being allocated at that size.
pub fn decompress_with_capacity(data: &[u8], capacity: usize) -> Result<Vec<u8>, ComprsError> {
    crate::require_input(data, "brotli")?;
    reject_large_window(data, "brotli decompress")?;
    crate::brotli_stream::decompress_all(
        data,
        Vec::new(),
        capacity,
        "brotli decompress",
        End::Lenient,
    )
}

/// Compress data with a custom dictionary using the brotli crate's low-level API.
///
/// An input of more than [`DICT_INPUT_LIMIT`] bytes is compressed with
/// neither the custom dictionary nor brotli's built-in one, into a stream
/// that decodes the same with or without the dictionary.
pub fn compress_with_dict(
    input: &[u8],
    dict: &[u8],
    quality: Option<u32>,
) -> Result<Vec<u8>, ComprsError> {
    let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;
    compress_with_dict_inner(input, dict, quality, "brotli compress with dict")
}

/// Low-level dictionary compression implementation.
///
/// brotli 9.0.0's encoder mishandles matches that would cross the end of a
/// custom dictionary: for some inputs it panics at qualities 2-9 and, at
/// qualities 10 and 11, emits copies that span the dictionary/data boundary,
/// which the decoder rejects. This function catches the panic (on targets
/// that unwind; wasm32 aborts on panic), checks quality 10-11 output by
/// decoding it, and in either case compresses the input again with neither
/// the custom dictionary nor brotli's built-in one
/// (`encode_without_dictionaries`). That stream decodes with or without the
/// dictionary. The encoder runs under [`crate::panic_guard::catch`], so that
/// a panic hook can leave out the panics recovered from here. An input of
/// more than [`DICT_INPUT_LIMIT`] bytes, on which the encoder can panic in
/// another way, goes to that fallback without the encoder ever taking the
/// dictionary.
///
/// Takes a checked `quality`, and reports encoder errors with `context`.
pub(crate) fn compress_with_dict_inner(
    input: &[u8],
    dict: &[u8],
    quality: u32,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    // The encoder turns the built-in dictionary off when given a custom one.
    let params = encoder_params(quality, true);
    let output = if dict.is_empty() {
        encode(input, dict, &params)
    } else if input.len() > DICT_INPUT_LIMIT {
        encode_without_dictionaries(input, quality)
    } else {
        #[cfg(test)]
        DICT_ENCODES.with(|count| count.set(count.get() + 1));
        match crate::panic_guard::catch(|| encode(input, dict, &params)) {
            Ok(Ok(output)) if quality < 10 || decodes_to(&output, dict, input) => Ok(output),
            Ok(Err(e)) => Err(e),
            Ok(Ok(_)) | Err(_) => encode_without_dictionaries(input, quality),
        }
    };
    output.map_err(|e| ComprsError::Operation {
        context,
        source: e.into(),
    })
}

#[cfg(test)]
thread_local! {
    /// How many times [`compress_with_dict_inner`] gave the encoder a custom
    /// dictionary on this thread, for the tests.
    static DICT_ENCODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many times [`compress_with_dict_inner`] gave the encoder a custom
/// dictionary on this thread.
#[cfg(test)]
pub(crate) fn dict_encodes() -> usize {
    DICT_ENCODES.with(std::cell::Cell::get)
}

/// Compress `input` with neither a custom dictionary nor brotli's built-in
/// one: the fallback of [`compress_with_dict_inner`].
///
/// A decoder treats a custom dictionary as data that precedes the stream:
/// the distances that reach past the decoded data in the window point into
/// it, and only those past its end into the built-in dictionary. A stream
/// encoded without a custom dictionary refers to the built-in one with the
/// distances just past the decoded data, which a decoder given a custom
/// dictionary reads as copies from that dictionary or as other words: it
/// returns different bytes, often without an error. With the built-in
/// dictionary off, the stream decodes the same with or without a custom
/// dictionary. Text that the built-in dictionary covers compresses less
/// without it, a cost that only the inputs that take the fallback pay: rare
/// ones, and those of more than [`DICT_INPUT_LIMIT`] bytes.
fn encode_without_dictionaries(
    input: &[u8],
    quality: u32,
) -> std::result::Result<Vec<u8>, std::io::Error> {
    encode(input, &[], &encoder_params(quality, false))
}

/// Whether `compressed` decodes with `dict` to exactly `expected`.
fn decodes_to(compressed: &[u8], dict: &[u8], expected: &[u8]) -> bool {
    decompress_with_dict_with_capacity(compressed, dict, expected.len())
        .is_ok_and(|output| output == expected)
}

/// The parameters of the low-level encoder: `quality`, a window of
/// 2^[`LG_WINDOW_SIZE`] bytes and, if `use_dictionary`, brotli's built-in
/// dictionary.
pub(crate) fn encoder_params(
    quality: u32,
    use_dictionary: bool,
) -> brotli::enc::BrotliEncoderParams {
    brotli::enc::BrotliEncoderParams {
        quality: quality as i32,
        lgwin: LG_WINDOW_SIZE as i32,
        use_dictionary,
        ..Default::default()
    }
}

/// Run the brotli encoder; an empty `dict` means no custom dictionary.
fn encode(
    input: &[u8],
    dict: &[u8],
    params: &brotli::enc::BrotliEncoderParams,
) -> std::result::Result<Vec<u8>, std::io::Error> {
    use std::io::Cursor;

    let mut r = Cursor::new(input);
    let mut output = Vec::with_capacity(input.len());
    let mut input_buffer = [0u8; BUFFER_SIZE];
    let mut output_buffer = [0u8; BUFFER_SIZE];
    // The allocator of the streams, which recycles the ring buffer of the
    // encoder: with a custom dictionary, the encoder allocates all of it on
    // every call (see `brotli_stream::RING_BUFFER`).
    let alloc = CountingAlloc::for_encoder();
    let mut nop =
        |_: &mut brotli::interface::PredictionModeContextMap<brotli::InputReferenceMut>,
         _: &mut [brotli::interface::StaticCommand],
         _: brotli::InputPair,
         _: &mut CountingAlloc| {};

    brotli::BrotliCompressCustomIoCustomDict(
        &mut brotli::IoReaderWrapper(&mut r),
        &mut brotli::IoWriterWrapper(&mut output),
        &mut input_buffer[..],
        &mut output_buffer[..],
        params,
        alloc,
        &mut nop,
        dict,
        std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "unexpected eof"),
    )?;
    Ok(crate::finish_output(output))
}

/// Decompress Brotli-compressed data that was compressed with a custom dictionary.
///
/// The output is limited to [`crate::MAX_DECOMPRESSED_SIZE`] bytes, as in
/// [`decompress`].
pub fn decompress_with_dict(data: &[u8], dict: &[u8]) -> Result<Vec<u8>, ComprsError> {
    decompress_with_dict_with_capacity(data, dict, crate::MAX_DECOMPRESSED_SIZE)
}

/// Decompress Brotli-compressed data with a custom dictionary and explicit capacity.
///
/// `capacity` limits the output size, as in [`decompress_with_capacity`].
pub fn decompress_with_dict_with_capacity(
    data: &[u8],
    dict: &[u8],
    capacity: usize,
) -> Result<Vec<u8>, ComprsError> {
    crate::require_input(data, "brotli")?;
    reject_large_window(data, "brotli decompress with dict")?;
    crate::brotli_stream::decompress_all(
        data,
        dict.to_vec(),
        capacity,
        "brotli decompress with dict",
        End::Lenient,
    )
}

/// Decompress a brotli stream with the custom dictionary `dict` (empty for
/// none) into at most `max_output` bytes, and reject input that does not end
/// at the end of the stream.
///
/// The other one-shot decoders of this module, such as
/// [`decompress_with_capacity`], ignore data after the end of the stream and
/// report a cut stream as invalid data, as they always have. This one fails,
/// like the decompression contexts of [`crate::brotli_stream`], with:
///
/// - [`ComprsError::Truncated`] for input that ends before the end of the
///   stream, including empty input;
/// - [`ComprsError::Corrupt`] for data after the end of the stream, for
///   invalid data ("Invalid Data") and for a Large Window Brotli stream;
/// - [`ComprsError::SizeLimit`] for output that would exceed `max_output`.
///
/// Its errors have the contexts of the other one-shot decoders: "brotli
/// decompress", or "brotli decompress with dict" with a dictionary.
pub fn decompress_strict(
    data: &[u8],
    dict: &[u8],
    max_output: usize,
) -> Result<Vec<u8>, ComprsError> {
    let context = if dict.is_empty() {
        "brotli decompress"
    } else {
        "brotli decompress with dict"
    };
    crate::require_input(data, "brotli")?;
    reject_large_window(data, context)?;
    crate::brotli_stream::decompress_all(data, dict.to_vec(), max_output, context, End::Strict)
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

/// English text, which brotli encodes with words of its built-in
/// dictionary, for the tests.
#[cfg(test)]
pub(crate) const TEXT: &[u8] =
    b"The quick brown fox jumps over the lazy dog. However, the government \
    and the people of the world have been working together in order to provide information \
    about something important. ";

/// The dictionary of [`dict_fallback_input`], for the tests.
#[cfg(test)]
pub(crate) const FALLBACK_DICT: [u8; 2] = [254, 255];

/// An input that brotli 9.0.0 fails to encode with [`FALLBACK_DICT`] at
/// qualities 5-11, so that [`compress_with_dict_inner`] takes its fallback,
/// for the tests: the input from the PR #615 fuzz targets, then [`TEXT`] 20
/// times.
#[cfg(test)]
pub(crate) fn dict_fallback_input() -> Vec<u8> {
    let mut data = vec![
        255, 164, 251, 255, 255, 240, 7, 0, 0, 0, 0, 0, 0, 0, 0, 41, 103, 0, 14,
    ];
    data.extend(TEXT.repeat(20));
    data
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
                let err = result.unwrap_err();
                assert!(matches!(err, ComprsError::Corrupt { .. }), "lgwin {lgwin}");
                assert!(
                    err.to_string()
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

    /// `len` bytes of xorshift noise, which brotli stores in uncompressed
    /// meta-blocks.
    fn random(len: usize) -> Vec<u8> {
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect()
    }

    /// Inputs for the tests of the one-shot decoders: short, compressible
    /// and incompressible data.
    fn samples() -> [Vec<u8>; 3] {
        [
            b"short".to_vec(),
            b"one-shot brotli decompression ".repeat(2000),
            random(20_000),
        ]
    }

    /// An encoder for the input of a one-shot decoder.
    type Encoder = fn(&[u8]) -> Vec<u8>;

    /// A one-shot decoder, called with the input and an output limit.
    type Decoder = fn(&[u8], usize) -> Result<Vec<u8>, ComprsError>;

    const DICT: &[u8] = b"brotli dictionary for the one-shot decoders";

    /// Every one-shot decoder with the context of its errors and the encoder
    /// of its input. The functions without a limit ignore it.
    fn decoders() -> [(&'static str, Encoder, Decoder); 4] {
        let plain = |data: &[u8]| compress(data, None).unwrap();
        let with_dict = |data: &[u8]| compress_with_dict(data, DICT, None).unwrap();
        [
            ("brotli decompress", plain, |data, _| decompress(data)),
            ("brotli decompress", plain, decompress_with_capacity),
            ("brotli decompress with dict", with_dict, |data, _| {
                decompress_with_dict(data, DICT)
            }),
            ("brotli decompress with dict", with_dict, |data, limit| {
                decompress_with_dict_with_capacity(data, DICT, limit)
            }),
        ]
    }

    #[test]
    fn decompress_ignores_data_after_the_stream() {
        for original in samples() {
            for (context, encode, decode) in decoders() {
                let mut input = encode(&original);
                input.extend(b"trailing data");
                input.extend(random(10_000));
                assert_eq!(
                    decode(&input, original.len()).unwrap(),
                    original,
                    "{context}"
                );
            }
        }
    }

    #[test]
    fn decompress_rejects_truncated_input() {
        for original in samples() {
            for (context, encode, decode) in decoders() {
                let compressed = encode(&original);
                for len in [1, compressed.len() / 2, compressed.len() - 1] {
                    assert_eq!(
                        decode(&compressed[..len], original.len())
                            .unwrap_err()
                            .to_string(),
                        format!("{context} failed: Invalid Data"),
                        "{len} of {} bytes",
                        compressed.len()
                    );
                }
            }
        }
    }

    /// The strict decoder without and with a dictionary, each with the
    /// context of its errors, the dictionary that it takes and the encoder of
    /// its input.
    fn strict_decoders() -> [(&'static str, &'static [u8], Encoder); 2] {
        [
            ("brotli decompress", b"", |data| {
                compress(data, None).unwrap()
            }),
            ("brotli decompress with dict", DICT, |data| {
                compress_with_dict(data, DICT, None).unwrap()
            }),
        ]
    }

    #[test]
    fn decompress_strict_round_trips() {
        for original in samples().into_iter().chain([Vec::new()]) {
            for (context, dict, encode) in strict_decoders() {
                let compressed = encode(&original);
                let output = decompress_strict(&compressed, dict, original.len()).unwrap();
                assert!(output == original, "{context}");
            }
        }
    }

    #[test]
    fn decompress_strict_reports_truncated_input() {
        for original in samples().into_iter().chain([Vec::new()]) {
            for (context, dict, encode) in strict_decoders() {
                let compressed = encode(&original);
                let cuts = [0, 1, compressed.len() / 2, compressed.len() - 1];
                for len in cuts.into_iter().filter(|&len| len < compressed.len()) {
                    let result = decompress_strict(&compressed[..len], dict, original.len());
                    assert!(
                        matches!(result, Err(ComprsError::Truncated("brotli"))),
                        "{context}, {len} of {} bytes: {:?}",
                        compressed.len(),
                        result.map(|output| output.len())
                    );
                }
            }
        }
    }

    #[test]
    fn decompress_strict_rejects_data_after_the_stream() {
        for original in samples().into_iter().chain([Vec::new()]) {
            for (context, dict, encode) in strict_decoders() {
                let compressed = encode(&original);
                for trailing in [&[0][..], &[0x3b], b"trailing data"] {
                    let input = [&compressed[..], trailing].concat();
                    let err = decompress_strict(&input, dict, original.len()).unwrap_err();
                    assert!(matches!(err, ComprsError::Corrupt { .. }), "{context}");
                    assert_eq!(
                        err.to_string(),
                        format!("{context} failed: unexpected data after the end of the stream")
                    );
                }
            }
        }
    }

    #[test]
    fn decompress_strict_rejects_invalid_data() {
        for (context, dict, _) in strict_decoders() {
            let err = decompress_strict(&[0xff; 16], dict, 1024).unwrap_err();
            assert!(matches!(err, ComprsError::Corrupt { .. }), "{context}");
            assert_eq!(err.to_string(), format!("{context} failed: Invalid Data"));

            let large_window = compress_large_window(b"large window", 22);
            let err = decompress_strict(&large_window, dict, 1024).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!("{context} failed: large-window brotli streams are not supported")
            );
        }
    }

    #[test]
    fn decompress_strict_limits_the_output() {
        for original in samples() {
            let n = original.len();
            for (context, dict, encode) in strict_decoders() {
                let compressed = encode(&original);
                assert!(decompress_strict(&compressed, dict, n).unwrap() == original);
                assert_eq!(
                    decompress_strict(&compressed, dict, n - 1)
                        .unwrap_err()
                        .to_string(),
                    format!("{context} exceeded maximum size of {} bytes", n - 1)
                );
            }
        }
    }

    #[test]
    fn decompress_rejects_invalid_data() {
        for (context, _, decode) in decoders() {
            assert_eq!(
                decode(&[0xff; 16], 1024).unwrap_err().to_string(),
                format!("{context} failed: Invalid Data")
            );
        }
    }

    #[test]
    fn decompress_with_capacity_limits_the_output() {
        for original in samples() {
            let n = original.len();
            // The decoders that take a limit.
            for (context, encode, decode) in decoders().into_iter().skip(1).step_by(2) {
                let compressed = encode(&original);
                assert_eq!(decode(&compressed, n).unwrap(), original, "{context}");
                assert_eq!(
                    decode(&compressed, n - 1).unwrap_err().to_string(),
                    format!("{context} exceeded maximum size of {} bytes", n - 1)
                );
                assert!(matches!(
                    decode(&compressed, 0),
                    Err(ComprsError::SizeLimit { limit: 0, .. })
                ));
            }
        }
        let empty = compress(b"", None).unwrap();
        assert_eq!(decompress_with_capacity(&empty, 0).unwrap(), b"");
        assert_eq!(
            decompress_with_dict_with_capacity(&empty, b"dictionary", 0).unwrap(),
            b""
        );
    }

    #[test]
    fn compression_quality_levels() {
        let data = b"Repeating data for compression quality testing. ".repeat(100);
        let compressed: Vec<_> = (0..=11)
            .map(|quality| compress(&data, Some(quality)).unwrap())
            .collect();
        for (quality, output) in compressed.iter().enumerate() {
            assert_eq!(decompress(output).unwrap(), data, "quality {quality}");
        }

        let fast = compressed[0].len();
        let default = compressed[DEFAULT_QUALITY as usize].len();
        let best = compressed[11].len();
        assert!(
            best <= default,
            "{best} bytes at quality 11, {default} at 6"
        );
        assert!(default <= fast, "{default} bytes at quality 6, {fast} at 0");
    }

    #[test]
    fn dict_round_trip() {
        let dict = br#"{"id":0,"name":"user","email":"@example.com"}"#.repeat(10);
        let original = br#"{"id":42,"name":"test_user","email":"test@example.com","active":true}"#;
        let compressed = compress_with_dict(original, &dict, None).unwrap();
        assert_eq!(decompress_with_dict(&compressed, &dict).unwrap(), original);

        // The output refers to the dictionary: it is smaller than without
        // one, and does not decode to the original without it.
        assert!(compressed.len() < compress(original, None).unwrap().len());
        assert_ne!(decompress(&compressed).ok().as_deref(), Some(&original[..]));
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

    /// Input from the PR #615 fuzz targets: brotli 9.0.0 cuts a match that
    /// starts on the last dictionary byte to a 1-byte copy and panics on it at
    /// qualities 5-9.
    #[test]
    fn dict_compress_survives_encoder_panic() {
        let data = [
            255, 164, 251, 255, 255, 240, 7, 0, 0, 0, 0, 0, 0, 0, 0, 41, 103, 0, 14,
        ];
        let dict = [254, 255];
        for quality in 0..=11 {
            let compressed = compress_with_dict(&data, &dict, Some(quality)).unwrap();
            assert_eq!(decompress_with_dict(&compressed, &dict).unwrap(), data);
        }
    }

    /// At qualities 10 and 11 brotli 9.0.0 encodes this input with a copy
    /// that starts in the dictionary and runs into the data, which the
    /// decoder rejects.
    #[test]
    fn dict_compress_output_decodes_at_quality_10_and_11() {
        let data = [2, 2, 3, 1, 2, 2, 3];
        let dict = [1, 0, 1, 1];
        for quality in [10, 11] {
            let compressed = compress_with_dict(&data, &dict, Some(quality)).unwrap();
            assert_eq!(decompress_with_dict(&compressed, &dict).unwrap(), data);
        }
    }

    /// The fallback stream must not use brotli's built-in dictionary: a
    /// decoder given the custom dictionary reads its references as copies
    /// from the custom dictionary, and returns different bytes (#642).
    #[test]
    fn dict_compress_fallback_decodes_with_the_dictionary() {
        let data = dict_fallback_input();
        for quality in 0..=11 {
            let compressed = compress_with_dict(&data, &FALLBACK_DICT, Some(quality)).unwrap();
            let decompressed = decompress_with_dict(&compressed, &FALLBACK_DICT).unwrap();
            assert!(decompressed == data, "quality {quality}");
            if quality >= 5 {
                // The output of the fallback, which needs no dictionary.
                assert!(
                    decompress(&compressed).unwrap() == data,
                    "quality {quality}"
                );
            }
        }
    }

    /// The fallback's output decodes with any custom dictionary, also for
    /// text that the built-in dictionary would encode.
    #[test]
    fn dict_fallback_decodes_with_any_dictionary() {
        let text_dict: Vec<u8> = b"lorem ipsum dolor sit amet "
            .iter()
            .copied()
            .cycle()
            .take(2048)
            .collect();
        for quality in 0..=11 {
            let compressed = encode_without_dictionaries(TEXT, quality).unwrap();
            assert_eq!(decompress(&compressed).unwrap(), TEXT, "quality {quality}");
            // Encoded with the built-in dictionary, the text decodes to other
            // bytes, or not at all, with a custom dictionary.
            let with_built_in = encode(TEXT, &[], &encoder_params(quality, true)).unwrap();
            for dict in [&FALLBACK_DICT[..], &text_dict] {
                let context = format!("quality {quality}, {}-byte dictionary", dict.len());
                assert_eq!(
                    decompress_with_dict(&compressed, dict).unwrap(),
                    TEXT,
                    "{context}"
                );
                if quality >= 4 {
                    assert_ne!(
                        decompress_with_dict(&with_built_in, dict).ok().as_deref(),
                        Some(TEXT),
                        "{context}"
                    );
                }
            }
        }
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
