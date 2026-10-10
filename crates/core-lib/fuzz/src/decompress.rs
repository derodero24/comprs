//! Decompression of fuzzer-chosen data through every API of a format.

use comprs_core::{ComprsError, gzip, zstd};
use libfuzzer_sys::arbitrary::{Error, Result, Unstructured};

use crate::format::Format;
use crate::plan::{self, ChunkPlan, Damage, MAX_LIMIT};
use crate::{check_heap, heap};

/// Largest data that [`fuzz_decompress`] compresses: twice the largest output
/// limit, so that the compressed data can exceed every limit.
const MAX_COMPRESSED_INPUT: usize = 2 * MAX_LIMIT;

/// Decompress fuzzer-chosen data as `format` through every comprs-core API
/// for it, with fuzzer-chosen output limits, dictionary and stream chunks.
///
/// The data is either the rest of the input as is, or the rest of the input
/// repeated, compressed with `format` and then damaged. Compressed data
/// reaches deeper into the decoder than random bytes, and repeated data
/// makes decompression bombs. Checks that:
///
/// - nothing panics, and no call outputs more than its limit. The exception
///   is the panics of brotli 9.0.0's dictionary encoder, which comprs-core
///   catches (#623): [`crate::panic_hook`] lets them through until a brotli
///   release fixes the encoder;
/// - each call's heap usage, including each call to a stream context, stays
///   within [`crate::heap_bound`];
/// - one-shot decompression succeeds under a limit exactly when the full
///   output fits in it, with the same output under any larger limit, and
///   fails with [`ComprsError::SizeLimit`] otherwise;
/// - zstd decompression with a prepared dictionary ([`Format::prepare`])
///   gives the result of decompression with its bytes;
/// - a stream context, fed in chunks, agrees with one-shot decompression
///   when both succeed;
/// - the LZ4 context in incremental mode, fed in chunks, gives the result of
///   one-shot decompression: the same output, or the same error.
pub fn fuzz_decompress(format: Format, input: &[u8]) -> Result<()> {
    let mut u = Unstructured::new(input);
    let limit = plan::limit(&mut u)?;
    let dict = plan::dict(&mut u, format)?;
    let max_output_size = read_max_output_size(&mut u, limit)?;
    let chunks = ChunkPlan::arbitrary(&mut u)?;
    let incremental = format == Format::Lz4 && u.arbitrary::<bool>()?;
    let keep_going = u.ratio(1, 8)?;
    let compress = if u.ratio(1, 2)? {
        Some((
            plan::level(&mut u, format)?,
            plan::repeat_count(&mut u)?,
            Damage::arbitrary(&mut u)?,
        ))
    } else {
        None
    };
    let rest = u.take_rest();

    let data = match compress {
        None => rest.to_vec(),
        Some((level, repeat, damage)) => {
            let original = plan::repeat(rest, repeat, MAX_COMPRESSED_INPUT);
            let level = plan::affordable_level(format, level, original.len(), false);
            let mut data = match format.compress(&original, dict, level) {
                Ok(data) => data,
                Err(_) if format.may_reject_dict(dict) => return Err(Error::IncorrectFormat),
                Err(error) => panic!("{format:?} compression failed: {error}"),
            };
            damage.apply(&mut data);
            data
        }
    };
    let input_len = data.len() + dict.map_or(0, <[u8]>::len);

    // One-shot, under the chosen limit and under the largest one.
    let (small, peak) = heap::measure(|| format.decompress(&data, dict, limit));
    check_heap(format, "one-shot", peak, limit, input_len);
    let (large, peak) = heap::measure(|| format.decompress(&data, dict, MAX_LIMIT));
    check_heap(format, "one-shot", peak, MAX_LIMIT, input_len);
    check_limits(format, limit, &small, &large);

    if let Some(prepared) = format.prepare(dict) {
        for (limit, expected) in [(limit, &small), (MAX_LIMIT, &large)] {
            let (result, peak) =
                heap::measure(|| zstd::decompress_prepared(&data, &prepared, limit));
            check_heap(format, "prepared one-shot", peak, limit, input_len);
            check_prepared(&result, expected);
        }
    }

    if format == Format::Gzip && large.is_ok() {
        assert!(
            gzip::read_header(&data).is_ok(),
            "gzip::read_header rejects a stream that decompresses"
        );
    }

    // Streaming, in fuzzer-chosen chunks.
    let Ok(stream_limit) = comprs_core::validate_max_output_size(max_output_size) else {
        assert!(
            format
                .decompressor(dict, max_output_size, incremental)
                .is_err(),
            "{format:?} context accepted max_output_size {max_output_size:?}"
        );
        return Ok(());
    };
    let (stream, peak) = heap::measure(|| format.decompressor(dict, max_output_size, incremental));
    check_heap(format, "stream creation", peak, 0, input_len);
    let mut stream = match stream {
        Ok(stream) => stream,
        Err(error) => {
            // Only a zstd dictionary is parsed up front.
            assert!(
                format == Format::Zstd && dict.is_some() && large.is_err(),
                "{format:?} context creation failed: {error}"
            );
            return Ok(());
        }
    };
    let streamed = chunks.run_measured(stream.as_mut(), &data, stream_limit, keep_going, &|peak| {
        check_heap(format, "stream call", peak, stream_limit, input_len)
    });

    if incremental && stream_limit == limit {
        check_incremental(&streamed, &small);
    }
    if let (Ok(streamed), Ok(one_shot)) = (&streamed, &small)
        && stream_limit == limit
    {
        assert!(
            streamed == one_shot,
            "{format:?} stream output ({} bytes) differs from one-shot output ({} bytes)",
            streamed.len(),
            one_shot.len()
        );
    }
    Ok(())
}

/// Read the `max_output_size` argument of a stream context: usually `limit`
/// (as a JavaScript number, possibly with a fraction to drop), sometimes the
/// default or an invalid value that context creation must reject.
fn read_max_output_size(u: &mut Unstructured, limit: usize) -> Result<Option<f64>> {
    let limit = limit as f64;
    Ok(match u.int_in_range(0..=15)? {
        0 => None,
        1 => Some(*u.choose(&[f64::NAN, f64::INFINITY, -1.0, -0.5])?),
        2 => Some(limit + 0.5),
        _ => Some(limit),
    })
}

/// Check one-shot results under `limit` (`small`) and under [`MAX_LIMIT`]
/// (`large`) against each other. `format` names the decoder in the messages.
pub(crate) fn check_limits(
    format: impl std::fmt::Debug,
    limit: usize,
    small: &std::result::Result<Vec<u8>, ComprsError>,
    large: &std::result::Result<Vec<u8>, ComprsError>,
) {
    match (small, large) {
        (Ok(small), _) if small.len() > limit => panic!(
            "{format:?} output of {} bytes exceeds the limit of {limit} bytes",
            small.len()
        ),
        (Ok(small), Ok(large)) => assert!(
            small == large,
            "{format:?} output differs between output limits"
        ),
        (Ok(_), Err(error)) => panic!(
            "{format:?} succeeds with a limit of {limit} bytes but fails with a limit of \
             {MAX_LIMIT} bytes: {error}"
        ),
        (Err(error), Ok(large)) if large.len() <= limit => panic!(
            "{format:?} fails with a limit of {limit} bytes on {} bytes of output: {error}",
            large.len()
        ),
        (Err(error), Ok(large)) => assert!(
            matches!(error, ComprsError::SizeLimit { .. }),
            "{format:?} output of {} bytes exceeds the limit of {limit} bytes, but the error is \
             not SizeLimit: {error}",
            large.len()
        ),
        (Err(_), Err(_)) => {}
    }
}

/// Check the result of zstd decompression with a prepared dictionary
/// (`prepared`) against that of decompression with its bytes (`raw`): the
/// same output, or the same error.
fn check_prepared(
    prepared: &std::result::Result<Vec<u8>, ComprsError>,
    raw: &std::result::Result<Vec<u8>, ComprsError>,
) {
    match (prepared, raw) {
        (Ok(prepared), Ok(raw)) => assert!(
            prepared == raw,
            "zstd output differs between a prepared dictionary and its bytes"
        ),
        (Err(prepared), Err(raw)) => assert_eq!(
            prepared.to_string(),
            raw.to_string(),
            "zstd errors differ between a prepared dictionary and its bytes"
        ),
        (Ok(_), Err(error)) => {
            panic!("zstd succeeds with a prepared dictionary but fails with its bytes: {error}")
        }
        (Err(error), Ok(_)) => {
            panic!("zstd fails with a prepared dictionary but succeeds with its bytes: {error}")
        }
    }
}

/// Check the result of incremental LZ4 decompression in chunks (`streamed`)
/// against that of one-shot decompression under the same limit
/// (`one_shot`): both decode the same frames, with the same checks in the
/// same order, so they give the same output, or the same error, whose
/// message names the stream context instead of the function.
fn check_incremental(
    streamed: &std::result::Result<Vec<u8>, ComprsError>,
    one_shot: &std::result::Result<Vec<u8>, ComprsError>,
) {
    match (streamed, one_shot) {
        (Ok(streamed), Ok(one_shot)) => assert!(
            streamed == one_shot,
            "Lz4 incremental output ({} bytes) differs from one-shot output ({} bytes)",
            streamed.len(),
            one_shot.len()
        ),
        (Err(streamed), Err(one_shot)) => assert_eq!(
            streamed
                .to_string()
                .replace("lz4 stream decompress", "lz4 decompress"),
            one_shot.to_string(),
            "Lz4 incremental and one-shot errors differ"
        ),
        (Ok(_), Err(error)) => panic!("Lz4 one-shot fails but incremental succeeds: {error}"),
        (Err(error), Ok(_)) => panic!("Lz4 incremental fails but one-shot succeeds: {error}"),
    }
}
