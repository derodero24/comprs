//! libbrotli against the Rust port of brotli that comprs used before it
//! (#563): each decodes what the other encodes, with and without raw
//! dictionaries, which the Rust port calls custom dictionaries, so that
//! data compressed with comprs 2.x keeps decompressing.

use std::io::Cursor;
use std::sync::Arc;

use comprs_brotli::{Decoder, Encoder, Error, Operation, PreparedDictionary, Status};

const KIB: usize = 1024;
const MIB: usize = 1024 * KIB;

/// Text that compresses well but repeats with variations, `len` bytes.
fn text(len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut i = 0u64;
    while out.len() < len {
        out.extend_from_slice(
            format!(
                "{{\"id\":{i},\"name\":\"user{}\",\"active\":{}}}\n",
                i * 7 % 1000,
                i.is_multiple_of(3)
            )
            .as_bytes(),
        );
        i += 1;
    }
    out.truncate(len);
    out
}

/// Bytes that do not compress, `len` of them.
fn noise(len: usize, seed: u64) -> Vec<u8> {
    let mut state = seed | 1;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect()
}

/// Compress `input` with libbrotli at `quality`, with `dictionary` if any.
fn c_compress(input: &[u8], quality: u32, dictionary: Option<&PreparedDictionary<'_>>) -> Vec<u8> {
    let mut encoder = Encoder::new().unwrap();
    encoder.set_quality(quality).unwrap();
    encoder.set_window(22).unwrap();
    if let Some(dictionary) = dictionary {
        encoder.attach(dictionary).unwrap();
    }
    let mut output = Vec::new();
    encoder
        .compress_all(Operation::Finish, input, &mut output)
        .unwrap();
    output
}

/// Decompress `data` with libbrotli, with `dictionary` if any.
fn c_decompress(data: &[u8], dictionary: &[u8]) -> Result<Vec<u8>, Error> {
    let mut decoder = Decoder::new()?;
    if !dictionary.is_empty() {
        decoder.attach(dictionary)?;
    }
    let mut input = data;
    let mut output = Vec::new();
    loop {
        output.reserve(64 * KIB);
        match decoder.decompress(&mut input, &mut output)? {
            Status::Finished => return Ok(output),
            Status::NeedsMoreOutput => {}
            Status::NeedsMoreInput => {
                return Err(Error::Decoder {
                    code: 0,
                    message: "truncated",
                });
            }
        }
    }
}

/// Compress `input` with the Rust port at `quality`, as comprs 2.x did:
/// with `dict` as its custom dictionary unless it is empty, which turns its
/// built-in dictionary off.
fn rust_compress(input: &[u8], dict: &[u8], quality: u32) -> Vec<u8> {
    let params = brotli::enc::BrotliEncoderParams {
        quality: quality as i32,
        lgwin: 22,
        ..Default::default()
    };
    let mut output = Vec::new();
    let mut input_buffer = [0u8; 4096];
    let mut output_buffer = [0u8; 4096];
    let mut nop =
        |_: &mut brotli::interface::PredictionModeContextMap<brotli::InputReferenceMut>,
         _: &mut [brotli::interface::StaticCommand],
         _: brotli::InputPair,
         _: &mut brotli::enc::StandardAlloc| {};
    brotli::BrotliCompressCustomIoCustomDict(
        &mut brotli::IoReaderWrapper(&mut Cursor::new(input)),
        &mut brotli::IoWriterWrapper(&mut output),
        &mut input_buffer[..],
        &mut output_buffer[..],
        &params,
        brotli::enc::StandardAlloc::default(),
        &mut nop,
        dict,
        std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "unexpected eof"),
    )
    .unwrap();
    output
}

/// Decompress `data` with the Rust port, with `dict` as its custom
/// dictionary.
fn rust_decompress(data: &[u8], dict: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    brotli_decompressor::BrotliDecompressCustomDict(
        &mut Cursor::new(data),
        &mut output,
        &mut [0u8; 4096],
        &mut [0u8; 4096],
        dict.to_vec(),
    )
    .unwrap();
    output
}

#[test]
fn libbrotli_round_trips_at_every_quality() {
    for input in [
        Vec::new(),
        b"a".to_vec(),
        text(100 * KIB),
        noise(70 * KIB, 1),
    ] {
        for quality in 0..=11 {
            let compressed = c_compress(&input, quality, None);
            assert_eq!(
                c_decompress(&compressed, &[]).unwrap(),
                input,
                "quality {quality}"
            );
            assert_eq!(
                rust_decompress(&compressed, &[]),
                input,
                "quality {quality}"
            );
        }
    }
}

#[test]
fn libbrotli_decodes_the_rust_port() {
    for input in [
        b"a".to_vec(),
        text(100 * KIB),
        noise(70 * KIB, 2),
        text(3 * MIB),
    ] {
        // The tests run unoptimized, where the Rust port is slow at the
        // high qualities.
        let qualities: &[u32] = if input.len() > MIB {
            &[0, 1, 5]
        } else {
            &[0, 1, 5, 6, 9, 11]
        };
        for &quality in qualities {
            let compressed = rust_compress(&input, &[], quality);
            assert_eq!(
                c_decompress(&compressed, &[]).unwrap(),
                input,
                "quality {quality}"
            );
        }
    }
}

/// The dictionaries of the dictionary tests: small, of zstd's default
/// size, and nearly as large as the window of 2^22 bytes, which is all of
/// a dictionary that the encoders can refer to.
fn dictionaries() -> Vec<Vec<u8>> {
    vec![
        text(2 * KIB),
        [text(60 * KIB), noise(50 * KIB, 3)].concat(),
        text(4 * MIB - 16),
    ]
}

/// Inputs that share strings with the dictionaries, and one that runs past
/// the window, where the stream's own data takes over.
fn dictionary_inputs() -> Vec<Vec<u8>> {
    vec![
        text(88),
        [text(30 * KIB), noise(3 * KIB, 4)].concat(),
        text(4 * MIB + 64 * KIB),
    ]
}

#[test]
fn raw_dictionaries_interoperate_with_the_rust_ports_custom_dictionaries() {
    for dict in dictionaries() {
        let prepared = PreparedDictionary::new(&dict, 11).unwrap();
        for input in dictionary_inputs() {
            // The tests run unoptimized, where the Rust port is slow: the
            // largest dictionary takes two qualities, and the input past the
            // window one quality and one dictionary.
            let qualities: &[u32] = match (input.len() > MIB, dict.len() > MIB) {
                (false, false) => &[1, 5, 6, 9, 10, 11],
                (false, true) => &[1, 6],
                (true, false) => &[1],
                (true, true) => &[],
            };
            for &quality in qualities {
                let from_rust = rust_compress(&input, &dict, quality);
                assert_eq!(
                    c_decompress(&from_rust, &dict).unwrap(),
                    input,
                    "Rust port to libbrotli, dictionary {}, input {}, quality {quality}",
                    dict.len(),
                    input.len(),
                );
                let from_c = c_compress(&input, quality, Some(&prepared));
                assert_eq!(
                    rust_decompress(&from_c, &dict),
                    input,
                    "libbrotli to Rust port, dictionary {}, input {}, quality {quality}",
                    dict.len(),
                    input.len(),
                );
                assert_eq!(c_decompress(&from_c, &dict).unwrap(), input);
            }
        }
    }
}

#[test]
fn a_dictionary_makes_small_messages_smaller() {
    let dict = text(64 * KIB);
    let message = text(200);
    let prepared = PreparedDictionary::new(&dict, 11).unwrap();
    let with = c_compress(&message, 5, Some(&prepared));
    let without = c_compress(&message, 5, None);
    assert!(
        with.len() * 2 < without.len(),
        "{} vs {}",
        with.len(),
        without.len()
    );
}

#[test]
fn a_shared_prepared_dictionary_serves_encoders_on_several_threads() {
    let dict: Arc<[u8]> = text(64 * KIB).into();
    let prepared = Arc::new(PreparedDictionary::shared(Arc::clone(&dict), 9).unwrap());
    assert!(prepared.memory_usage() > 0);
    let handles: Vec<_> = (0..4)
        .map(|i| {
            let prepared = Arc::clone(&prepared);
            std::thread::spawn(move || {
                let input = text(1000 + i * 100);
                let mut encoder = Encoder::new().unwrap();
                encoder.set_quality(9).unwrap();
                encoder.attach_shared(prepared).unwrap();
                let mut output = Vec::new();
                encoder
                    .compress_all(Operation::Finish, &input, &mut output)
                    .unwrap();
                (input, output)
            })
        })
        .collect();
    for handle in handles {
        let (input, output) = handle.join().unwrap();
        assert_eq!(c_decompress(&output, &dict).unwrap(), input);
    }
}

#[test]
fn flush_emits_everything_that_was_given() {
    let mut encoder = Encoder::new().unwrap();
    encoder.set_quality(6).unwrap();
    let mut output = Vec::new();
    let first = text(10 * KIB);
    encoder
        .compress_all(Operation::Flush, &first, &mut output)
        .unwrap();
    assert!(!encoder.has_more_output());
    let mut decoder = Decoder::new().unwrap();
    let mut decoded = Vec::with_capacity(first.len() + 1);
    let mut input = &output[..];
    assert_eq!(
        decoder.decompress(&mut input, &mut decoded).unwrap(),
        Status::NeedsMoreInput
    );
    assert_eq!(decoded, first);

    let second = text(20 * KIB);
    let start = output.len();
    encoder
        .compress_all(Operation::Finish, &second, &mut output)
        .unwrap();
    assert!(encoder.is_finished());
    let mut input = &output[start..];
    decoded.reserve(second.len());
    assert_eq!(
        decoder.decompress(&mut input, &mut decoded).unwrap(),
        Status::Finished
    );
    assert!(decoder.is_finished());
    assert_eq!(decoded, [first, second].concat());
}

#[test]
fn the_decoder_writes_no_more_than_the_room_given() {
    let input = text(MIB);
    let compressed = c_compress(&input, 5, None);
    let mut decoder = Decoder::new().unwrap();
    let mut rest = &compressed[..];
    let mut output = Vec::with_capacity(1000);
    assert_eq!(
        decoder.decompress(&mut rest, &mut output).unwrap(),
        Status::NeedsMoreOutput
    );
    assert_eq!(output.len(), output.capacity());
    assert_eq!(output, input[..output.len()]);
    assert!(decoder.memory_usage() > 0);
}

#[test]
fn the_decoder_reports_corrupt_data_and_data_after_the_stream() {
    let compressed = c_compress(&text(10 * KIB), 5, None);
    let mut corrupt = compressed.clone();
    let middle = corrupt.len() / 2;
    corrupt[middle] ^= 0xff;
    corrupt[middle + 1] ^= 0x55;
    match c_decompress(&corrupt, &[]) {
        Err(Error::Decoder { code, message }) => {
            assert!(
                code < 0 && message.starts_with("_ERROR"),
                "{code} {message}"
            );
        }
        other => panic!("expected a decoder error, got {other:?}"),
    }

    let mut decoder = Decoder::new().unwrap();
    let with_trailer = [&compressed[..], b"trailer"].concat();
    let mut input = &with_trailer[..];
    let mut output = Vec::with_capacity(20 * KIB);
    assert_eq!(
        decoder.decompress(&mut input, &mut output).unwrap(),
        Status::Finished
    );
    assert_eq!(input, b"trailer");
}

#[test]
fn the_decoder_rejects_large_window_streams() {
    // The Large Window Brotli header: 0x11, then a window of 2^30 bytes.
    let large_window = [0x11, 0x1e, 0x03];
    assert!(matches!(
        c_decompress(&large_window, &[]),
        Err(Error::Decoder { .. })
    ));
}

#[test]
fn parameters_are_checked() {
    let mut encoder = Encoder::new().unwrap();
    assert_eq!(
        encoder.set_quality(12),
        Err(Error::InvalidParameter("quality"))
    );
    assert_eq!(
        encoder.set_window(9),
        Err(Error::InvalidParameter("window"))
    );
    assert_eq!(
        encoder.set_window(25),
        Err(Error::InvalidParameter("window"))
    );
    encoder.set_size_hint(usize::MAX).unwrap();
    assert!(PreparedDictionary::new(b"dict", 12).is_err());
    assert!(comprs_brotli::max_compressed_size(1000).is_some_and(|size| size > 1000));
    assert_eq!(comprs_brotli::version() >> 24, 1);
}

#[test]
fn an_encoder_takes_no_parameters_once_it_has_started() {
    let dict = text(KIB);
    let prepared = PreparedDictionary::new(&dict, 11).unwrap();
    let mut encoder = Encoder::new().unwrap();
    let mut output = Vec::new();
    encoder
        .compress_all(Operation::Flush, b"started", &mut output)
        .unwrap();
    assert!(encoder.set_quality(5).is_err());
    assert!(encoder.attach(&prepared).is_err());
    assert!(encoder.memory_usage() > 0);
}
