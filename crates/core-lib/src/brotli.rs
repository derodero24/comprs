//! Brotli compression and decompression, with libbrotli, Google's C brotli
//! library, through comprs-brotli (#563).

use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::Arc;

use comprs_brotli::{Encoder, Operation, PreparedDictionary};

use crate::brotli_stream::End;
use crate::dictionary::Dictionary;
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
/// next byte then picks a window of up to 1 GiB. Every decoder here rejects
/// these streams, as RFC 7932 decoders, Node's zlib among them, do; the
/// one-shot functions and the decompression contexts check the header up
/// front, so that they report this error rather than "Invalid Data".
pub(crate) fn reject_large_window(data: &[u8], context: &'static str) -> Result<(), ComprsError> {
    if data.first().is_some_and(|&byte| byte & 0x7f == 0x11) {
        return Err(ComprsError::Corrupt {
            context,
            source: "large-window brotli streams are not supported".into(),
        });
    }
    Ok(())
}

/// The error of an encoder, or of a decoder that ran out of memory, with
/// `context`.
pub(crate) fn operation_error(context: &'static str, error: comprs_brotli::Error) -> ComprsError {
    ComprsError::Operation {
        context,
        source: error.into(),
    }
}

/// The error of a decoder with `context`: [`ComprsError::Operation`] when it
/// ran out of memory, and otherwise [`ComprsError::Corrupt`] with the
/// message "Invalid Data", which the decoders of comprs have always given.
pub(crate) fn decoder_error(context: &'static str, error: comprs_brotli::Error) -> ComprsError {
    if error.is_out_of_memory() {
        operation_error(context, error)
    } else {
        invalid_data(context)
    }
}

/// [`ComprsError::Corrupt`] with `context` and the message "Invalid Data".
pub(crate) fn invalid_data(context: &'static str) -> ComprsError {
    ComprsError::Corrupt {
        context,
        source: std::io::Error::new(std::io::ErrorKind::InvalidData, "Invalid Data").into(),
    }
}

/// An encoder at `quality`, with a window of 2^[`LG_WINDOW_SIZE`] bytes.
pub(crate) fn encoder<'d>(quality: u32) -> Result<Encoder<'d>, comprs_brotli::Error> {
    let mut encoder = Encoder::new()?;
    encoder.set_quality(quality)?;
    encoder.set_window(LG_WINDOW_SIZE)?;
    Ok(encoder)
}

/// The most dictionaries that a thread keeps prepared for
/// [`prepared_dictionary`].
const PREPARED_DICTIONARIES: usize = 4;

/// The longest dictionary, in bytes, that a thread keeps prepared. A
/// prepared dictionary holds about 270 KB of tables, and 4 bytes more for
/// each byte of the dictionary, so a thread keeps at most about 5 MB.
const MAX_KEPT_DICTIONARY: usize = 256 * 1024;

thread_local! {
    /// The dictionaries that [`prepared_dictionary`] prepared last on this
    /// thread, the most recently used first.
    ///
    /// libbrotli hashes a dictionary before an encoder can refer to it,
    /// which took 0.3 ms for a dictionary of 4 KiB, 40 times as long as
    /// compressing a 150-byte message with it, and 2 to 4 ms for 256 KiB.
    /// A [`Dictionary`] keeps its own, prepared when it is created.
    /// The one-shot functions take the dictionary's bytes on every call, so
    /// the thread keeps the last few prepared, as it is likely to get the
    /// same again. The memory that they hold is not reported to the
    /// engine.
    static PREPARED: RefCell<VecDeque<Arc<PreparedDictionary<'static>>>> =
        const { RefCell::new(VecDeque::new()) };
}

/// `dict` prepared for the encoder: one that this thread prepared before,
/// if it kept it, or a new one, which it keeps if `dict` is short enough.
///
/// libbrotli prepares a raw dictionary the same way for every quality.
pub(crate) fn prepared_dictionary(
    dict: &[u8],
) -> Result<Arc<PreparedDictionary<'static>>, comprs_brotli::Error> {
    let prepare = || PreparedDictionary::shared(Arc::from(dict), QUALITY.max).map(Arc::new);
    if dict.len() > MAX_KEPT_DICTIONARY {
        return prepare();
    }
    PREPARED.with_borrow_mut(|kept| {
        if let Some(index) = kept.iter().position(|kept| kept.bytes() == dict) {
            let prepared = kept.remove(index).unwrap_or_else(|| unreachable!());
            kept.push_front(Arc::clone(&prepared));
            return Ok(prepared);
        }
        let prepared = prepare()?;
        kept.truncate(PREPARED_DICTIONARIES - 1);
        kept.push_front(Arc::clone(&prepared));
        Ok(prepared)
    })
}

/// Compress all of `input` at `quality` into one stream, with the prepared
/// custom dictionary `dict`, if any.
///
/// The encoder gets the size of the input as a hint, as libbrotli's own
/// one-shot `BrotliEncoderCompress` gives it, and the output starts with
/// room for as many bytes as the input.
fn encode(
    input: &[u8],
    dict: Option<Arc<PreparedDictionary<'static>>>,
    quality: u32,
) -> Result<Vec<u8>, comprs_brotli::Error> {
    let mut encoder = encoder(quality)?;
    if let Some(dict) = dict {
        encoder.attach_shared(dict)?;
    }
    encoder.set_size_hint(input.len())?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(input.len())
        .map_err(|_| comprs_brotli::Error::OutOfMemory)?;
    encoder.compress_all(Operation::Finish, input, &mut output)?;
    Ok(crate::finish_output(output))
}

/// Compress data using Brotli.
pub fn compress(data: &[u8], quality: Option<u32>) -> Result<Vec<u8>, ComprsError> {
    let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;
    encode(data, None, quality).map_err(|e| operation_error("brotli compress", e))
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
    crate::brotli_stream::decompress_all(data, &[], capacity, "brotli decompress", End::Lenient)
}

/// Compress data with a custom dictionary: a raw (LZ77 prefix) dictionary,
/// which the stream refers to as data that precedes it. An empty `dict`
/// stands for none.
pub fn compress_with_dict(
    input: &[u8],
    dict: &[u8],
    quality: Option<u32>,
) -> Result<Vec<u8>, ComprsError> {
    let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;
    compress_with_dict_inner(input, dict, quality, "brotli compress with dict")
}

/// Compress `input` with a prepared brotli dictionary, into the output of
/// [`compress_with_dict`] with its bytes. The dictionary was prepared when
/// it was created, so the call does not hash it again, nor look it up among
/// those that the thread keeps (#707).
///
/// Fails with [`ComprsError::InvalidArg`] for a zstd dictionary ("this
/// Dictionary is for zstd"), then for an invalid `quality`.
pub fn compress_prepared(
    input: &[u8],
    dictionary: &Dictionary,
    quality: Option<u32>,
) -> Result<Vec<u8>, ComprsError> {
    let dict = Arc::clone(dictionary.brotli_prepared()?);
    let quality = QUALITY.check(quality.unwrap_or(DEFAULT_QUALITY))?;
    encode(input, Some(dict), quality).map_err(|e| operation_error("brotli compress with dict", e))
}

/// [`compress_with_dict`] with a checked `quality`, reporting encoder errors
/// with `context`.
pub(crate) fn compress_with_dict_inner(
    input: &[u8],
    dict: &[u8],
    quality: u32,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    let dict = (!dict.is_empty())
        .then(|| prepared_dictionary(dict))
        .transpose()
        .map_err(|e| operation_error(context, e))?;
    compress_with_prepared_inner(input, dict, quality, context)
}

/// Compress `input` with the prepared dictionary `dict`, if any, as
/// [`compress_with_dict_inner`] does with its bytes.
pub(crate) fn compress_with_prepared_inner(
    input: &[u8],
    dict: Option<Arc<PreparedDictionary<'static>>>,
    quality: u32,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    encode(input, dict, quality).map_err(|e| operation_error(context, e))
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
        dict,
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
    crate::brotli_stream::decompress_all(data, dict, max_output, context, End::Strict)
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

/// An input that brotli 9.0.0, the Rust port of brotli that comprs used
/// before libbrotli, failed to encode with [`FALLBACK_DICT`] at qualities
/// 5-11, so that comprs compressed it again without the dictionary (#642),
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
    use std::io::Read;

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
            let mut encoder = comprs_brotli::Encoder::new().unwrap();
            encoder.set_quality(5).unwrap();
            encoder.set_window(lgwin).unwrap();
            let mut compressed = Vec::new();
            encoder
                .compress_all(Operation::Finish, &original, &mut compressed)
                .unwrap();
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

    /// The input on which the Rust port failed with a dictionary (#642)
    /// round-trips at every quality, and refers to the dictionary.
    #[test]
    fn dict_compress_round_trips_the_input_that_the_rust_port_failed_on() {
        let data = dict_fallback_input();
        for quality in 0..=11 {
            let compressed = compress_with_dict(&data, &FALLBACK_DICT, Some(quality)).unwrap();
            let decompressed = decompress_with_dict(&compressed, &FALLBACK_DICT).unwrap();
            assert!(decompressed == data, "quality {quality}");
        }
    }

    /// The dictionary serves an input of any length: brotli 9.0.0 could
    /// panic on one of more than 8 MiB (#703), which comprs compressed
    /// without the dictionary.
    #[test]
    fn dict_compress_uses_the_dictionary_on_long_inputs() {
        let dict = b"long inputs with a dictionary ".repeat(70);
        let data = [&dict[..], &TEXT.repeat(80_000)].concat();
        assert!(data.len() > 8 << 20);
        let compressed = compress_with_dict(&data, &dict, Some(5)).unwrap();
        assert!(decompress_with_dict(&compressed, &dict).unwrap() == data);
        assert!(decompress(&compressed).ok().as_deref() != Some(&data[..]));
    }

    #[test]
    fn a_thread_keeps_the_dictionaries_that_it_prepared_last() {
        let dicts: Vec<Vec<u8>> = (0..=PREPARED_DICTIONARIES)
            .map(|i| format!("dictionary {i} ").repeat(50).into_bytes())
            .collect();
        let first = prepared_dictionary(&dicts[0]).unwrap();
        assert!(Arc::ptr_eq(
            &first,
            &prepared_dictionary(&dicts[0]).unwrap()
        ));
        assert!(first.bytes() == dicts[0]);
        // A copy of the bytes finds it too.
        assert!(Arc::ptr_eq(
            &first,
            &prepared_dictionary(&dicts[0].clone()).unwrap()
        ));
        for dict in &dicts[1..PREPARED_DICTIONARIES] {
            prepared_dictionary(dict).unwrap();
        }
        // Using it keeps it at the front: the next one pushes out the least
        // recently used, the second.
        assert!(Arc::ptr_eq(
            &first,
            &prepared_dictionary(&dicts[0]).unwrap()
        ));
        let second = PREPARED.with_borrow(|kept| Arc::clone(&kept[PREPARED_DICTIONARIES - 1]));
        assert!(second.bytes() == dicts[1]);
        prepared_dictionary(&dicts[PREPARED_DICTIONARIES]).unwrap();
        assert!(!Arc::ptr_eq(
            &second,
            &prepared_dictionary(&dicts[1]).unwrap()
        ));
        assert!(PREPARED.with_borrow(VecDeque::len) == PREPARED_DICTIONARIES);
        // Another thread keeps its own.
        let dict = dicts[0].clone();
        std::thread::spawn(move || {
            assert!(PREPARED.with_borrow(VecDeque::is_empty));
            prepared_dictionary(&dict).unwrap();
        })
        .join()
        .unwrap();
    }

    #[test]
    fn a_thread_does_not_keep_long_dictionaries() {
        let dict = vec![7; MAX_KEPT_DICTIONARY + 1];
        let prepared = prepared_dictionary(&dict).unwrap();
        assert!(!Arc::ptr_eq(
            &prepared,
            &prepared_dictionary(&dict).unwrap()
        ));
        assert!(
            PREPARED.with_borrow(|kept| kept.iter().all(|kept| kept.bytes().len() < dict.len()))
        );
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
