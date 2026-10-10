//! Prepared dictionaries, driven through the public API.

mod common;

use std::sync::{Arc, LazyLock};
use std::thread;

use common::{Context, drive, text};
use comprs_core::dictionary::{Dictionary, DictionaryFormat};
use comprs_core::{ComprsError, MAX_DECOMPRESSED_SIZE, brotli, brotli_stream, zstd, zstd_stream};

/// A JSON message of about 110 bytes, like those of #557.
fn message(i: u64) -> Vec<u8> {
    let user = i * 7919 % 100_000;
    let event = ["alpha", "bravo", "charlie", "delta"][(i % 4) as usize];
    format!(
        r#"{{"id":{i},"user":"user_{user}","email":"user{user}@example.com","ts":{},"event":"{event}","active":{}}}"#,
        1_700_000_000 + i * 37,
        i.is_multiple_of(3)
    )
    .into_bytes()
}

/// A dictionary trained on messages other than those that the tests
/// compress.
static TRAINED: LazyLock<Vec<u8>> = LazyLock::new(|| {
    let samples: Vec<Vec<u8>> = (100_000..102_000).map(message).collect();
    zstd::train_dictionary(&samples, 8 * 1024).unwrap()
});

/// A prepared zstd dictionary of [`TRAINED`] at `level`.
fn prepared(level: Option<i32>) -> Dictionary {
    Dictionary::new(&TRAINED, DictionaryFormat::Zstd, level.map(f64::from)).unwrap()
}

/// Compress `data` with a stream context: the frame declares no content
/// size.
fn stream(ctx: Result<impl Context, ComprsError>, data: &[u8]) -> Vec<u8> {
    let frame = drive(&mut ctx.unwrap(), data, &[4096]).unwrap();
    assert!(matches!(
        ::zstd::zstd_safe::get_frame_content_size(&frame),
        Ok(None)
    ));
    frame
}

/// Inputs for the round trips: a message, which the dictionary is for; a
/// larger input, which zstd still compresses with the parameters prepared
/// for the dictionary; and one of over 128 KiB, which zstd compresses with
/// parameters for its size instead. `ZSTD_compress_usingCDict` keeps the
/// prepared parameters for an input smaller than 128 KiB or than 6 times
/// the dictionary's content (zstd 1.5.7, `zstd_compress.c`).
fn inputs() -> [Vec<u8>; 3] {
    [message(7), text(20_000), text(132_000)]
}

#[test]
fn prepared_and_raw_dictionaries_are_interchangeable() {
    let raw = &TRAINED[..];
    for level in [-5, 1, 3, 19] {
        let dict = prepared(Some(level));
        assert_eq!(dict.level(), Some(level));
        for input in inputs() {
            let case = format!("level {level}, {} bytes", input.len());

            // Frames with a content size, from the one-shot functions.
            let frame = zstd::compress_prepared(&input, &dict, None, 0).unwrap();
            assert!(
                zstd::decompress_with_dict(&frame, raw).unwrap() == input,
                "{case}"
            );
            assert!(
                zstd::decompress_prepared(&frame, &dict, MAX_DECOMPRESSED_SIZE).unwrap() == input,
                "{case}"
            );
            let frame = zstd::compress_with_dict(&input, raw, Some(level)).unwrap();
            assert!(
                zstd::decompress_prepared(&frame, &dict, input.len()).unwrap() == input,
                "{case}"
            );

            // Frames without a content size, from the stream contexts.
            let ctx = zstd_stream::CompressDictContext::with_prepared(&dict, None, 0);
            let frame = stream(ctx, &input);
            assert!(
                zstd::decompress_with_dict(&frame, raw).unwrap() == input,
                "{case}"
            );
            let ctx = zstd_stream::CompressDictContext::new(raw, Some(level));
            let frame = stream(ctx, &input);
            assert!(
                zstd::decompress_prepared(&frame, &dict, input.len()).unwrap() == input,
                "{case}"
            );
            let ctx = zstd_stream::DecompressDictContext::with_prepared(&dict, None);
            assert!(
                drive(&mut ctx.unwrap(), &frame, &[1000]).unwrap() == input,
                "{case}"
            );
        }
    }
}

#[test]
fn compress_prepared_takes_the_level_of_the_dictionary_by_default() {
    let input = text(20_000);
    let default = prepared(None);
    assert_eq!(default.level(), Some(zstd::DEFAULT_LEVEL));
    // Level 0 stands for the default level, as in the other functions.
    assert_eq!(prepared(Some(0)).level(), Some(zstd::DEFAULT_LEVEL));

    let compress = |dict: &Dictionary, level| zstd::compress_prepared(&input, dict, level, 0);
    let memory = default.memory_usage();
    let at_3 = compress(&default, None).unwrap();
    assert_eq!(compress(&default, Some(3)).unwrap(), at_3);
    assert_eq!(compress(&default, Some(0)).unwrap(), at_3);
    // Both use the prepared compression dictionary rather than another.
    assert_eq!(default.memory_usage(), memory);
    for level in [-5, 1, 19] {
        // Another level gets a compression dictionary of its own, the one
        // that a dictionary prepared at that level has.
        let other = compress(&default, Some(level)).unwrap();
        assert_ne!(other, at_3, "level {level}");
        assert_eq!(other, compress(&prepared(Some(level)), None).unwrap());
        assert_eq!(other, compress(&default, Some(level)).unwrap());
    }
    // Level 0 selects the default level whatever the dictionary's, as in
    // the other functions, so a dictionary of level 19 prepares level 3 for
    // it besides its own.
    let at_19 = prepared(Some(19));
    let memory = at_19.memory_usage();
    assert_eq!(compress(&at_19, Some(0)).unwrap(), at_3);
    assert!(at_19.memory_usage() > memory);

    // The stream contexts take the level in the same way.
    let streamed = |dict: &Dictionary, level| {
        stream(
            zstd_stream::CompressDictContext::with_prepared(dict, level, 0),
            &input,
        )
    };
    assert_eq!(
        streamed(&at_19, None),
        stream(
            zstd_stream::CompressDictContext::new(&TRAINED, Some(19)),
            &input
        )
    );
    let streamed_at_3 = streamed(&default, None);
    assert_eq!(streamed(&at_19, Some(3)), streamed_at_3);
    assert_eq!(streamed(&at_19, Some(0)), streamed_at_3);
}

#[test]
fn threads_share_a_dictionary() {
    // The prepared level and five others, more than the dictionary keeps,
    // so that the threads prepare, look up and drop levels at the same
    // time, including levels that other threads still compress with.
    const LEVELS: [Option<i32>; 6] = [None, Some(1), Some(2), Some(6), Some(9), Some(-3)];
    let dict = Arc::new(prepared(None));
    let threads: Vec<_> = (0..4u64)
        .map(|t| {
            let dict = Arc::clone(&dict);
            thread::spawn(move || {
                for i in 0..1000 {
                    let input = message(t * 1000 + i);
                    let level = LEVELS[((t + i) % 6) as usize];
                    let frame = zstd::compress_prepared(&input, &dict, level, 0).unwrap();
                    let output = zstd::decompress_prepared(&frame, &dict, input.len()).unwrap();
                    assert_eq!(output, input);
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }

    // Whichever levels the threads prepared last, the dictionary keeps 3 of
    // the 5 others: its memory grew by the size of 3 of their compression
    // dictionaries.
    let base = prepared(None).memory_usage();
    let sizes: Vec<usize> = LEVELS[1..]
        .iter()
        .map(|&level| {
            let dict = prepared(None);
            zstd::compress_prepared(b"data", &dict, level, 0).unwrap();
            dict.memory_usage() - base
        })
        .collect();
    let sum = |subset: u32| -> usize {
        (0..sizes.len())
            .filter(|i| subset >> i & 1 == 1)
            .map(|i| sizes[i])
            .sum()
    };
    let kept = dict.memory_usage() - base;
    assert!(
        (0..1 << sizes.len()).any(|subset: u32| subset.count_ones() == 3 && sum(subset) == kept),
        "{kept} bytes, {sizes:?}"
    );
}

#[test]
fn a_dictionary_keeps_its_own_copy_of_the_bytes() {
    let mut raw = TRAINED.clone();
    let dict = Dictionary::new(&raw, DictionaryFormat::Zstd, None).unwrap();
    raw.fill(0);
    assert_eq!(dict.raw(), &TRAINED[..]);
    let input = message(1);
    let frame = zstd::compress_prepared(&input, &dict, None, 0).unwrap();
    assert_eq!(zstd::decompress_with_dict(&frame, &TRAINED).unwrap(), input);
}

#[test]
fn dictionaries_report_their_memory() {
    let brotli = Dictionary::new(&TRAINED, DictionaryFormat::Brotli, None).unwrap();
    assert_eq!(brotli.memory_usage(), TRAINED.len());

    // zstd keeps copies of the bytes in its compression and decompression
    // dictionaries, along with their tables.
    let zstd = prepared(None);
    let prepared_only = zstd.memory_usage();
    assert!(prepared_only > 3 * TRAINED.len(), "{prepared_only} bytes");
    zstd::compress_prepared(b"data", &zstd, Some(19), 0).unwrap();
    assert!(zstd.memory_usage() > prepared_only + TRAINED.len());
}

#[test]
fn prepared_brotli_dictionaries_round_trip() {
    let dict = Dictionary::new(&TRAINED, DictionaryFormat::Brotli, None).unwrap();
    assert_eq!(dict.format(), DictionaryFormat::Brotli);
    assert_eq!(dict.level(), None);
    let raw = dict.raw_for(DictionaryFormat::Brotli).unwrap();
    assert_eq!(raw, &TRAINED[..]);
    for quality in [0, 6, 11] {
        for input in [message(7), text(20_000)] {
            let case = format!("quality {quality}, {} bytes", input.len());
            let compressed = brotli::compress_with_dict(&input, raw, Some(quality)).unwrap();
            let output = brotli::decompress_with_dict(&compressed, raw).unwrap();
            assert!(output == input, "{case}");

            // The stream contexts take the same bytes.
            let ctx = brotli_stream::CompressDictContext::new(raw, Some(quality));
            let compressed = drive(&mut ctx.unwrap(), &input, &[4096]).unwrap();
            let ctx = brotli_stream::DecompressDictContext::new(raw, None);
            let output = drive(&mut ctx.unwrap(), &compressed, &[1000]).unwrap();
            assert!(output == input, "{case}");
        }
    }
}

#[test]
fn raw_for_rejects_a_dictionary_of_the_other_format() {
    let zstd = prepared(None);
    let brotli = Dictionary::new(&TRAINED, DictionaryFormat::Brotli, None).unwrap();
    assert_eq!(zstd.raw_for(DictionaryFormat::Zstd).unwrap(), &TRAINED[..]);
    assert_eq!(
        invalid_arg(zstd.raw_for(DictionaryFormat::Brotli)),
        "this Dictionary is for zstd"
    );
    assert_eq!(
        invalid_arg(brotli.raw_for(DictionaryFormat::Zstd)),
        "this Dictionary is for brotli"
    );
}

#[cfg(feature = "zstdmt")]
#[test]
fn compress_prepared_with_workers_round_trips() {
    // Two jobs at level 1, whose jobs hold 2 MiB. The first refers to the
    // dictionary, so the frame does not decode without it.
    let data = text(3 * 1024 * 1024);
    let raw = &data[..64 * 1024];
    let dict = Dictionary::new(raw, DictionaryFormat::Zstd, Some(1.0)).unwrap();
    let frame = zstd::compress_prepared(&data, &dict, None, 2).unwrap();
    assert!(zstd::decompress_with_dict(&frame, raw).unwrap() == data);
    assert!(zstd::decompress_prepared(&frame, &dict, data.len()).unwrap() == data);
    assert!(zstd::decompress(&frame).is_err());
    // zstd's output does not depend on the number of workers from 1 up, and
    // the workers compress the jobs independently.
    assert!(frame == zstd::compress_prepared(&data, &dict, None, 4).unwrap());
    assert!(frame != zstd::compress_prepared(&data, &dict, None, 0).unwrap());

    let ctx = zstd_stream::CompressDictContext::with_prepared(&dict, None, 2);
    let frame = stream(ctx, &data);
    assert!(zstd::decompress_prepared(&frame, &dict, data.len()).unwrap() == data);
}

/// The message of `result`'s error, which must be an invalid argument.
#[track_caller]
fn invalid_arg<T>(result: Result<T, ComprsError>) -> String {
    let Err(err) = result else {
        panic!("succeeded instead of failing");
    };
    assert!(matches!(err, ComprsError::InvalidArg(_)), "{err:?}");
    err.to_string()
}

#[test]
fn new_validates_its_arguments() {
    for format in [DictionaryFormat::Zstd, DictionaryFormat::Brotli] {
        assert_eq!(
            invalid_arg(Dictionary::new(&[], format, None)),
            "dictionary must not be empty"
        );
    }
    for level in [23.0, -131_073.0, 1.5, f64::NAN, f64::INFINITY] {
        assert_eq!(
            invalid_arg(Dictionary::new(
                &TRAINED,
                DictionaryFormat::Zstd,
                Some(level)
            )),
            "zstd compression level must be an integer between -131072 and 22",
            "{level}"
        );
    }
    for level in [6.0, 0.0, 1.5] {
        assert_eq!(
            invalid_arg(Dictionary::new(
                &TRAINED,
                DictionaryFormat::Brotli,
                Some(level)
            )),
            "level applies to zstd dictionaries only",
            "{level}"
        );
    }
    for level in [-131_072.0, 22.0, -0.0] {
        assert!(Dictionary::new(b"dictionary", DictionaryFormat::Zstd, Some(level)).is_ok());
    }
}

#[test]
fn new_reports_a_corrupt_zstd_dictionary() {
    // The magic number of a zstd dictionary, a dictionary ID and entropy
    // tables that do not parse.
    let mut corrupt = vec![0x37, 0xA4, 0x30, 0xEC, 1, 0, 0, 0];
    corrupt.extend([0xFF; 64]);
    let err = Dictionary::new(&corrupt, DictionaryFormat::Zstd, None).unwrap_err();
    assert!(matches!(err, ComprsError::Operation { .. }), "{err:?}");
    assert_eq!(
        err.to_string(),
        "zstd dictionary preparation failed: Dictionary is corrupted"
    );
    // So is a trained dictionary cut inside the entropy tables that follow
    // its ID. Cut halfway, it only has less content, which zstd accepts.
    for cut in [9, 64] {
        let err = Dictionary::new(&TRAINED[..cut], DictionaryFormat::Zstd, None).unwrap_err();
        assert_eq!(
            err.to_string(),
            "zstd dictionary preparation failed: Dictionary is corrupted",
            "{cut} bytes"
        );
    }
    assert!(Dictionary::new(&TRAINED[..TRAINED.len() / 2], DictionaryFormat::Zstd, None).is_ok());
    // brotli takes any bytes as a dictionary.
    assert!(Dictionary::new(&corrupt, DictionaryFormat::Brotli, None).is_ok());
}

#[test]
fn zstd_functions_reject_a_brotli_dictionary() {
    let dict = Dictionary::new(&TRAINED, DictionaryFormat::Brotli, None).unwrap();
    let frame = zstd::compress_with_dict(b"data", &TRAINED, None).unwrap();
    // The format is checked first.
    for message in [
        invalid_arg(zstd::compress_prepared(b"data", &dict, None, 0)),
        invalid_arg(zstd::compress_prepared(b"data", &dict, Some(23), 257)),
        invalid_arg(zstd::decompress_prepared(&frame, &dict, 1024)),
        invalid_arg(zstd::decompress_prepared(&[], &dict, 1024)),
        invalid_arg(zstd_stream::CompressDictContext::with_prepared(
            &dict,
            Some(23),
            257,
        )),
        invalid_arg(zstd_stream::DecompressDictContext::with_prepared(
            &dict,
            Some(-1.0),
        )),
    ] {
        assert_eq!(message, "this Dictionary is for brotli");
    }
}

#[test]
fn compress_prepared_validates_the_level_and_workers() {
    let dict = prepared(None);
    // The workers are checked before the level, as in the other functions.
    for (level, workers) in [(None, 257), (Some(23), 257), (Some(0), u32::MAX)] {
        assert_eq!(
            invalid_arg(zstd::compress_prepared(b"data", &dict, level, workers)),
            "zstd workers must be an integer between 0 and 256"
        );
        assert_eq!(
            invalid_arg(zstd_stream::CompressDictContext::with_prepared(
                &dict, level, workers
            )),
            "zstd workers must be an integer between 0 and 256"
        );
    }
    for level in [23, -131_073, i32::MAX] {
        assert_eq!(
            invalid_arg(zstd::compress_prepared(b"data", &dict, Some(level), 0)),
            "zstd compression level must be an integer between -131072 and 22"
        );
        assert_eq!(
            invalid_arg(zstd_stream::CompressDictContext::with_prepared(
                &dict,
                Some(level),
                0
            )),
            "zstd compression level must be an integer between -131072 and 22"
        );
    }
    #[cfg(not(feature = "zstdmt"))]
    assert_eq!(
        invalid_arg(zstd::compress_prepared(b"data", &dict, None, 1)),
        "zstd workers are not supported in this build"
    );
}

/// The error of [`zstd::decompress_prepared`] for `data`, which must be
/// that of the raw dictionary function with the bytes of `dict`.
#[track_caller]
fn decompress_error(data: &[u8], dict: &Dictionary, limit: usize) -> ComprsError {
    let err = zstd::decompress_prepared(data, dict, limit).unwrap_err();
    let raw = zstd::decompress_with_dict_with_capacity(data, dict.raw(), limit).unwrap_err();
    assert_eq!(err.code(), raw.code(), "{err:?}");
    assert_eq!(err.to_string(), raw.to_string());
    err
}

#[test]
fn decompress_prepared_reports_errors_like_decompress_with_dict() {
    let dict = prepared(None);
    let input = text(20_000);
    let with_size = zstd::compress_prepared(&input, &dict, None, 0).unwrap();
    let without_size = stream(
        zstd_stream::CompressDictContext::with_prepared(&dict, None, 0),
        &input,
    );
    for frame in [&with_size, &without_size] {
        let n = input.len();
        assert!(zstd::decompress_prepared(frame, &dict, n).unwrap() == input);
        let err = decompress_error(frame, &dict, n - 1);
        assert!(matches!(err, ComprsError::SizeLimit { .. }), "{err:?}");
        assert_eq!(
            err.to_string(),
            format!(
                "zstd decompress with dict exceeded maximum size of {} bytes",
                n - 1
            )
        );
        for cut in [1, frame.len() / 2, frame.len() - 1] {
            assert!(matches!(
                decompress_error(&frame[..cut], &dict, n),
                ComprsError::Truncated("zstd")
            ));
        }
        let garbage = [&frame[..], b"trailing garbage"].concat();
        let err = decompress_error(&garbage, &dict, n);
        assert!(matches!(err, ComprsError::Corrupt { .. }), "{err:?}");
    }
    assert!(matches!(
        decompress_error(&[], &dict, 1024),
        ComprsError::Truncated("zstd")
    ));

    // The frames of another trained dictionary name its ID, which differs
    // from that of `dict` and from the ID 0 of a raw-content dictionary.
    let samples: Vec<Vec<u8>> = (200_000..201_000).map(message).collect();
    let other_trained = zstd::train_dictionary(&samples, 4096).unwrap();
    let other_frames = [
        zstd::compress_with_dict(&message(1), &other_trained, None).unwrap(),
        stream(
            zstd_stream::CompressDictContext::new(&other_trained, None),
            &message(1),
        ),
    ];
    let raw_content = Dictionary::new(&input[..4096], DictionaryFormat::Zstd, None).unwrap();
    for frame in &other_frames {
        for dict in [&dict, &raw_content] {
            let err = decompress_error(frame, dict, 1024);
            assert!(matches!(err, ComprsError::Corrupt { .. }), "{err:?}");
            assert_eq!(
                err.to_string(),
                "zstd decompress with dict failed: Dictionary mismatch"
            );
        }
    }
}
