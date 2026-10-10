//! Compress fuzzer-chosen data, then check that every way of decompressing
//! it gives the data back.

use comprs_core::detect::{self, Format as Detected};
use comprs_core::dictionary::Dictionary;
use comprs_core::{ComprsError, gzip, zstd};
use libfuzzer_sys::arbitrary::{Error, Result, Unstructured};

use crate::format::{Format, unsigned};
use crate::plan::{self, ChunkPlan};

/// Largest data that [`fuzz_round_trip`] compresses: enough for several
/// blocks of every format.
const MAX_DATA_LEN: usize = 256 * 1024;

/// Compress the rest of `input`, repeated a fuzzer-chosen number of times,
/// with a fuzzer-chosen format, level and dictionary, either in one call or
/// in chunks. Checks that:
///
/// - compression with valid parameters succeeds, unless zstd reads the
///   dictionary as a formatted one ([`Format::may_reject_dict`]);
/// - auto-detection recognizes the output, and decompresses it;
/// - one-shot and stream decompression return the data, also when the
///   output limit is exactly the data's length, and fail with
///   [`ComprsError::SizeLimit`] when it is one byte less;
/// - a prepared zstd dictionary ([`Format::prepare`]) decompresses the
///   output, and compresses the data into a frame that its bytes
///   decompress;
/// - a gzip header written with the data reads back unchanged.
pub fn fuzz_round_trip(input: &[u8]) -> Result<()> {
    let mut u = Unstructured::new(input);
    let format = *u.choose(&Format::ALL)?;
    let dict = plan::dict(&mut u, format)?;
    let level = plan::level(&mut u, format)?;
    let header = if format == Format::Gzip && u.ratio(1, 4)? {
        Some(header(&mut u)?)
    } else {
        None
    };
    let compress_chunks = if header.is_none() && u.arbitrary::<bool>()? {
        Some(ChunkPlan::arbitrary(&mut u)?)
    } else {
        None
    };
    let mut decompress_chunks = ChunkPlan::arbitrary(&mut u)?;
    let incremental = format == Format::Lz4 && u.arbitrary::<bool>()?;
    if format == Format::Lz4 && !incremental {
        decompress_chunks = decompress_chunks.without_flushes();
    }
    let repeat = plan::repeat_count(&mut u)?;
    let data = plan::repeat(u.take_rest(), repeat, MAX_DATA_LEN);
    let level = plan::affordable_level(format, level, data.len(), compress_chunks.is_some());

    let compressed = match (&header, &compress_chunks) {
        (Some(header), _) => gzip::compress_with_header(&data, header, unsigned(level)),
        (None, Some(chunks)) => format
            .compressor(dict, level)
            .and_then(|mut stream| chunks.run(stream.as_mut(), &data, usize::MAX, false)),
        (None, None) => format.compress(&data, dict, level),
    };
    let compressed = match compressed {
        Ok(compressed) => compressed,
        Err(_) if format.may_reject_dict(dict) => return Err(Error::IncorrectFormat),
        Err(error) => panic!("{format:?} compression failed: {error}"),
    };

    check_detect(format, dict, &data, &compressed);
    if let Some(header) = &header {
        check_header(header, &compressed);
    }

    let decompressed = format
        .decompress_unlimited(&compressed, dict)
        .unwrap_or_else(|error| panic!("{format:?} decompression failed: {error}"));
    assert!(
        decompressed == data,
        "{format:?} round trip changed the data"
    );

    // Output limits of exactly the data's length and one byte less.
    let limit = data.len();
    let exact = format.decompress(&compressed, dict, limit);
    assert!(
        exact.as_deref().is_ok_and(|output| output == data),
        "{format:?} decompression with a limit of exactly {limit} bytes failed: {:?}",
        exact.err()
    );
    let streamed = format
        .decompressor(dict, Some(limit as f64), incremental)
        .and_then(|mut stream| decompress_chunks.run(stream.as_mut(), &compressed, limit, false));
    assert!(
        streamed.as_deref().is_ok_and(|output| output == data),
        "{format:?} stream decompression with a limit of exactly {limit} bytes failed: {:?}",
        streamed.err()
    );
    if let Some(limit) = limit.checked_sub(1) {
        let short = format.decompress(&compressed, dict, limit);
        assert!(
            matches!(short, Err(ComprsError::SizeLimit { .. })),
            "{format:?} decompression of {} bytes with a limit of {limit} bytes: {short:?}",
            data.len()
        );
        let streamed = format
            .decompressor(dict, Some(limit as f64), incremental)
            .and_then(|mut stream| {
                decompress_chunks.run(stream.as_mut(), &compressed, limit, false)
            });
        assert!(
            matches!(streamed, Err(ComprsError::SizeLimit { .. })),
            "{format:?} stream decompression of {} bytes with a limit of {limit} bytes: \
             {streamed:?}",
            data.len()
        );
    }

    if let Some(prepared) = format.prepare(dict) {
        check_prepared(&prepared, level, &data, &compressed);
    }
    Ok(())
}

/// Check that `prepared` decompresses `compressed` to `data`, and compresses
/// `data` at `level` into a frame that the bytes of `prepared` decompress.
fn check_prepared(prepared: &Dictionary, level: Option<i32>, data: &[u8], compressed: &[u8]) {
    let limit = data.len();
    let decompressed = zstd::decompress_prepared(compressed, prepared, limit);
    assert!(
        decompressed.as_deref().is_ok_and(|output| output == data),
        "zstd decompression with a prepared dictionary failed: {:?}",
        decompressed.err()
    );
    let frame = zstd::compress_prepared(data, prepared, level, 0).unwrap_or_else(|error| {
        panic!("zstd compression with a prepared dictionary failed: {error}")
    });
    let decompressed = zstd::decompress_with_dict_with_capacity(&frame, prepared.raw(), limit);
    assert!(
        decompressed.as_deref().is_ok_and(|output| output == data),
        "zstd decompression of a frame of a prepared dictionary with its bytes failed: {:?}",
        decompressed.err()
    );
}

/// Read gzip header options.
fn header(u: &mut Unstructured) -> Result<gzip::GzipHeaderOptions> {
    let filename = if u.arbitrary::<bool>()? {
        // NUL bytes cannot be stored in the header (#546).
        Some(u.arbitrary::<String>()?.replace('\0', ""))
    } else {
        None
    };
    let mtime = if u.arbitrary::<bool>()? {
        Some(u.arbitrary()?)
    } else {
        None
    };
    Ok(gzip::GzipHeaderOptions { filename, mtime })
}

/// Check that auto-detection recognizes `compressed` as `format` and
/// decompresses it to `data`, where the format makes that possible.
fn check_detect(format: Format, dict: Option<&[u8]>, data: &[u8], compressed: &[u8]) {
    let detected = detect::detect(compressed);
    let expected = match format {
        Format::Zstd => Detected::Zstd,
        Format::Gzip => Detected::Gzip,
        Format::Lz4 => Detected::Lz4,
        // Brotli has no magic number: detection decodes the first byte, which
        // empty data does not have and dictionary data cannot be decoded
        // without the dictionary.
        Format::Brotli if data.is_empty() || dict.is_some() => return,
        Format::Brotli => Detected::Brotli,
        // Raw deflate has no header to detect.
        Format::Deflate => return,
    };
    assert_eq!(
        detected, expected,
        "{format:?} output detected as {detected}"
    );
    if dict.is_none() {
        let decompressed = detect::decompress(compressed)
            .unwrap_or_else(|error| panic!("auto-detecting {format:?} decompression: {error}"));
        assert!(
            decompressed == data,
            "auto-detecting {format:?} decompression changed the data"
        );
    }
}

/// Check that the header of `compressed` holds what `options` set.
fn check_header(options: &gzip::GzipHeaderOptions, compressed: &[u8]) {
    let header = gzip::read_header(compressed).expect("the gzip header can be read");
    assert_eq!(header.filename, options.filename, "gzip filename");
    assert_eq!(header.mtime, options.mtime.unwrap_or(0), "gzip mtime");
}
