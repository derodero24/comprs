//! Decompression with format detection, through the unified layer.

use comprs_core::ComprsError;
use comprs_core::unified::{
    self, CompressOptions, DecompressContext, DecompressOptions, Format as Unified,
};
use libfuzzer_sys::arbitrary::{Result, Unstructured};

use crate::decompress::check_limits;
use crate::format::Format;
use crate::plan::{self, ChunkPlan, Damage, MAX_LIMIT};
use crate::{check_heap, heap};

/// Largest data that [`fuzz_unified_decompress`] compresses: twice the
/// largest output limit, so that the compressed data can exceed every limit.
const MAX_COMPRESSED_INPUT: usize = 2 * MAX_LIMIT;

/// The format whose decoder may use the most heap memory, whose bound
/// applies to detection, which may pick any decoder.
const LARGEST_DECODER: Format = Format::Brotli;

/// Decompress fuzzer-chosen data with the unified layer and no format, so
/// that it detects the format: in one call, and with a stream context fed in
/// fuzzer-chosen chunks and then finished.
///
/// The data is either the rest of the input as is, or the rest of the input
/// repeated, compressed in a fuzzer-chosen format, raw deflate included,
/// which detection never picks, and then damaged. Checks that:
///
/// - nothing panics, and no call outputs more than its limit;
/// - each call's heap usage, including each call to the stream context,
///   stays within [`crate::heap_bound`] for the decoder that may use the
///   most;
/// - data whose format detection does not find fails with
///   [`ComprsError::UnknownFormat`], and other data gives the result of
///   decompression in the detected format, except that a brotli stream that
///   does not decode fails with [`ComprsError::UnknownFormat`] as well;
/// - one-shot decompression succeeds under a limit exactly when the full
///   output fits in it, with the same output under any larger limit, and
///   fails with [`ComprsError::SizeLimit`] otherwise;
/// - the stream context agrees with one-shot decompression when both
///   succeed.
pub fn fuzz_unified_decompress(input: &[u8]) -> Result<()> {
    let mut u = Unstructured::new(input);
    let limit = plan::limit(&mut u)?;
    let chunks = ChunkPlan::arbitrary(&mut u)?;
    let keep_going = u.ratio(1, 8)?;
    let compress = if u.ratio(1, 2)? {
        let format = *u.choose(&Unified::ALL)?;
        Some((
            format,
            level(&mut u, format)?,
            plan::repeat_count(&mut u)?,
            Damage::arbitrary(&mut u)?,
        ))
    } else {
        None
    };
    let rest = u.take_rest();

    let data = match compress {
        None => rest.to_vec(),
        Some((format, level, repeat, damage)) => {
            let original = plan::repeat(rest, repeat, MAX_COMPRESSED_INPUT);
            let level = level
                .and_then(|(format, level)| {
                    plan::affordable_level(format, Some(level), original.len(), false)
                })
                .map(f64::from);
            let options = CompressOptions {
                level,
                ..CompressOptions::default()
            };
            let mut data = unified::compress(&original, format, &options)
                .unwrap_or_else(|error| panic!("{format} compression failed: {error}"));
            damage.apply(&mut data);
            data
        }
    };
    let detected = unified::detect(&data);
    let input_len = data.len();

    // One-shot, under the chosen limit and under the largest one.
    let auto = |limit: usize| DecompressOptions {
        max_output_size: Some(limit as f64),
        ..DecompressOptions::default()
    };
    let (small, peak) = heap::measure(|| unified::decompress(&data, &auto(limit)));
    check_heap(LARGEST_DECODER, "detection", peak, limit, input_len);
    let (large, peak) = heap::measure(|| unified::decompress(&data, &auto(MAX_LIMIT)));
    check_heap(LARGEST_DECODER, "detection", peak, MAX_LIMIT, input_len);
    check_limits(format_args!("detection"), limit, &small, &large);
    check_detected(detected, &data, &large);

    // Streaming, in fuzzer-chosen chunks.
    let (stream, peak) = heap::measure(|| DecompressContext::new(&auto(limit)));
    check_heap(LARGEST_DECODER, "stream creation", peak, 0, input_len);
    let mut stream = stream.unwrap_or_else(|error| panic!("stream creation failed: {error}"));
    // The lz4 decompression context decodes complete frames on flush, which
    // ends its input.
    let chunks = if detected == Some(Unified::Lz4) {
        chunks.without_flushes()
    } else {
        chunks
    };
    let streamed = chunks.run_measured(&mut stream, &data, limit, keep_going, &|peak| {
        check_heap(LARGEST_DECODER, "stream call", peak, limit, input_len)
    });

    if let (Ok(streamed), Ok(one_shot)) = (&streamed, &small) {
        assert!(
            streamed == one_shot,
            "stream output ({} bytes) differs from one-shot output ({} bytes)",
            streamed.len(),
            one_shot.len()
        );
    }
    Ok(())
}

/// Read a compression level for `format`, with the format of the fuzz
/// harness that has the same levels; `None` for the default level, and for
/// lz4, which takes none.
fn level(u: &mut Unstructured, format: Unified) -> Result<Option<(Format, i32)>> {
    let format = match format {
        Unified::Zstd => Format::Zstd,
        Unified::Gzip => Format::Gzip,
        Unified::Deflate | Unified::DeflateRaw => Format::Deflate,
        Unified::Brotli => Format::Brotli,
        Unified::Lz4 => return Ok(None),
    };
    Ok(plan::level(u, format)?.map(|level| (format, level)))
}

/// Check the result of decompression with detection (`result`, under
/// [`MAX_LIMIT`]) against `detected`, the format that detection finds in
/// `data`.
fn check_detected(
    detected: Option<Unified>,
    data: &[u8],
    result: &std::result::Result<Vec<u8>, ComprsError>,
) {
    let Some(format) = detected else {
        assert!(
            matches!(result, Err(ComprsError::UnknownFormat(_))),
            "decompression with detection accepted data of no detected format"
        );
        return;
    };
    let options = DecompressOptions {
        format: Some(format),
        max_output_size: Some(MAX_LIMIT as f64),
        dictionary: None,
    };
    let (explicit, peak) = heap::measure(|| unified::decompress(data, &options));
    check_heap(LARGEST_DECODER, "one-shot", peak, MAX_LIMIT, data.len());
    match (result, &explicit) {
        (Ok(detected), Ok(explicit)) => assert!(
            detected == explicit,
            "{format} output differs between detection and the format"
        ),
        // A brotli stream that does not decode is of unknown format.
        (Err(ComprsError::UnknownFormat(_)), Err(ComprsError::Corrupt { .. }))
        | (Err(ComprsError::UnknownFormat(_)), Err(ComprsError::Truncated(_)))
            if format == Unified::Brotli => {}
        (Err(detected), Err(explicit)) => assert_eq!(
            detected.to_string(),
            explicit.to_string(),
            "{format} errors differ between detection and the format"
        ),
        (Ok(_), Err(error)) => {
            panic!("{format} succeeds with detection but fails with the format: {error}")
        }
        (Err(error), Ok(_)) => {
            panic!("{format} fails with detection but succeeds with the format: {error}")
        }
    }
}
