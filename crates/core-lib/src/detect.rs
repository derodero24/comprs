//! Unified auto-detect decompression API.
//!
//! Detects the compression format from its magic number, or for brotli by
//! decoding the start of the data, and decompresses accordingly.

use brotli::enc::StandardAlloc;
use brotli::{BrotliDecompressStream, BrotliResult, BrotliState};

use crate::ComprsError;
use crate::lz4::{FRAME_MAGIC as LZ4_MAGIC, LEGACY_MAGIC as LZ4_LEGACY_MAGIC, SKIPPABLE_MAGIC};

/// Zstd magic number: 0xFD2FB528.
pub(crate) const ZSTD_MAGIC: u32 = 0xFD2F_B528;

/// Gzip magic number: 0x1F 0x8B.
const GZIP_MAGIC: [u8; 2] = [0x1F, 0x8B];

/// How much of the input [`detect`] decodes to recognize brotli: 64 KiB.
pub(crate) const BROTLI_PROBE_SIZE: usize = 64 * 1024;

/// Compression format detected from input data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Zstd,
    Gzip,
    Brotli,
    Lz4,
    Unknown,
}

impl std::fmt::Display for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Format::Zstd => write!(f, "zstd"),
            Format::Gzip => write!(f, "gzip"),
            Format::Brotli => write!(f, "brotli"),
            Format::Lz4 => write!(f, "lz4"),
            Format::Unknown => write!(f, "unknown"),
        }
    }
}

/// Detect the compression format of the given data.
///
/// zstd, gzip and LZ4 frames, including LZ4 legacy frames, are recognized by
/// their magic numbers. Skippable frames, which zstd and LZ4 share, are
/// skipped: the frame after them decides the format.
///
/// Brotli has no magic number, so it is recognized by decoding up to the
/// first 64 KiB of `data`. They must decode without error and either hold a
/// whole brotli stream that ends where `data` ends, decode to more bytes than
/// they hold, or fill the 64 KiB. The start of a brotli stream that does not
/// compress, which brotli stores uncompressed, is thus recognized only once
/// it fills the 64 KiB. Other data passes only by filling them: about 5% of
/// random data of 64 KiB or more does, as it decodes as a long uncompressed
/// meta-block.
#[must_use]
pub fn detect(data: &[u8]) -> Format {
    if data.starts_with(&GZIP_MAGIC) {
        return Format::Gzip;
    }
    let Some(frame) = skip_skippable_frames(data) else {
        return Format::Unknown;
    };
    match frame.first_chunk().map(|magic| u32::from_le_bytes(*magic)) {
        Some(ZSTD_MAGIC) => Format::Zstd,
        Some(LZ4_MAGIC | LZ4_LEGACY_MAGIC) => Format::Lz4,
        // Brotli streams have no skippable frames.
        _ if frame.len() == data.len() && is_brotli(data) => Format::Brotli,
        _ => Format::Unknown,
    }
}

/// The data after the skippable frames at the start of `data`, or `None` if
/// it ends inside one.
pub(crate) fn skip_skippable_frames(mut data: &[u8]) -> Option<&[u8]> {
    while let Some(magic) = data.first_chunk() {
        if !SKIPPABLE_MAGIC.contains(&u32::from_le_bytes(*magic)) {
            break;
        }
        // The magic number, the size of the user data, then the user data.
        let (header, rest) = data.split_first_chunk::<8>()?;
        let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
        data = rest.get(len as usize..)?;
    }
    Some(data)
}

/// Whether `data` looks like a brotli stream, as described for [`detect`].
fn is_brotli(data: &[u8]) -> bool {
    match probe_brotli(data, false) {
        BrotliProbe::Invalid => false,
        BrotliProbe::Ended(len) => len == data.len(),
        BrotliProbe::Expands => true,
        BrotliProbe::NeedsMoreInput => data.len() >= BROTLI_PROBE_SIZE,
    }
}

/// What decoding the first 64 KiB of some data as brotli found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BrotliProbe {
    /// The data is not a brotli stream.
    Invalid,
    /// A brotli stream ends after this many bytes.
    Ended(usize),
    /// The data decoded to more bytes than it holds. Only compressed
    /// meta-blocks do, and data that is not brotli practically never
    /// decodes as one.
    Expands,
    /// The first 64 KiB, or all of the data if it is shorter, decoded
    /// without error as the start of a brotli stream that does not expand.
    NeedsMoreInput,
}

/// Decode up to the first 64 KiB of `data` as a brotli stream, until it
/// fails, ends, expands or needs more input.
///
/// When the decoder runs out of input, it writes as much of the output that
/// it holds as the 4 KiB buffer takes, so a stream that the first 4 KiB of
/// output do not show to expand may expand once the decoder writes the
/// rest. With `drain`, the probe takes all of it before it gives up:
/// [`detect`] decides without, as it always has, while
/// [`crate::unified::detect_prefix`] needs a probe whose answer for a brotli
/// stream that compresses does not change as more of the stream arrives.
pub(crate) fn probe_brotli(data: &[u8], drain: bool) -> BrotliProbe {
    let input = &data[..data.len().min(BROTLI_PROBE_SIZE)];
    let mut state = BrotliState::new(
        StandardAlloc::default(),
        StandardAlloc::default(),
        StandardAlloc::default(),
    );
    // Probe RFC 7932 streams only: see `crate::brotli::reject_large_window`.
    state.large_window = false;
    let mut output = [0; crate::brotli::BUFFER_SIZE];
    let mut available_in = input.len();
    let mut input_offset = 0;
    let mut total_out = 0;
    loop {
        let mut available_out = output.len();
        let mut output_offset = 0;
        let result = BrotliDecompressStream(
            &mut available_in,
            &mut input_offset,
            input,
            &mut available_out,
            &mut output_offset,
            &mut output,
            &mut total_out,
            &mut state,
        );
        match result {
            BrotliResult::ResultFailure => return BrotliProbe::Invalid,
            BrotliResult::ResultSuccess => return BrotliProbe::Ended(input_offset),
            _ if total_out > input_offset => return BrotliProbe::Expands,
            BrotliResult::NeedsMoreOutput => {}
            BrotliResult::NeedsMoreInput if drain && output_offset > 0 => {}
            BrotliResult::NeedsMoreInput => return BrotliProbe::NeedsMoreInput,
        }
    }
}

/// The error for data whose format [`detect`] cannot determine.
fn unknown_format() -> ComprsError {
    ComprsError::UnknownFormat(
        "unable to detect compression format; use algorithm-specific functions (zstdDecompress, gzipDecompress, brotliDecompress, lz4Decompress, or deflateDecompress for raw deflate) instead".to_string(),
    )
}

/// Decompress data by auto-detecting the compression format.
///
/// The output is limited to [`crate::MAX_DECOMPRESSED_SIZE`] bytes. Brotli is
/// only a guess: data detected as brotli that does not decode as brotli fails
/// with [`ComprsError::UnknownFormat`], as data of no known format does, not
/// with a brotli error.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    decompress_with_capacity(data, crate::MAX_DECOMPRESSED_SIZE)
}

/// Decompress data by auto-detecting the compression format, with explicit
/// capacity.
///
/// `capacity` limits the output size, as the `decompress_with_capacity`
/// function of each format does; otherwise it works like [`decompress`].
pub fn decompress_with_capacity(data: &[u8], capacity: usize) -> Result<Vec<u8>, ComprsError> {
    match detect(data) {
        Format::Zstd => crate::zstd::decompress_with_capacity(data, capacity),
        Format::Gzip => crate::gzip::decompress_with_capacity(data, capacity),
        Format::Brotli => {
            crate::brotli::decompress_with_capacity(data, capacity).map_err(|e| match e {
                ComprsError::Operation { .. }
                | ComprsError::Corrupt { .. }
                | ComprsError::Truncated(_) => unknown_format(),
                e => e,
            })
        }
        Format::Lz4 => crate::lz4::decompress_with_capacity(data, capacity),
        Format::Unknown => Err(unknown_format()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn detect_zstd() {
        let data = zstd::bulk::compress(b"test data for zstd", 3).unwrap();
        assert_eq!(detect(&data), Format::Zstd);
    }

    #[test]
    fn detect_gzip() {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(b"test data for gzip").unwrap();
        let data = encoder.finish().unwrap();
        assert_eq!(detect(&data), Format::Gzip);
    }

    #[test]
    fn detect_brotli() {
        let mut output = Vec::new();
        {
            let mut compressor = brotli::CompressorWriter::new(&mut output, 4096, 6, 22);
            compressor.write_all(b"test data for brotli").unwrap();
        }
        assert_eq!(detect(&output), Format::Brotli);
    }

    #[test]
    fn detect_lz4() {
        let mut compressed = Vec::new();
        let mut encoder = lz4_flex::frame::FrameEncoder::new(&mut compressed);
        encoder.write_all(b"test data for lz4").unwrap();
        encoder.finish().unwrap();
        assert_eq!(detect(&compressed), Format::Lz4);
    }

    #[test]
    fn detect_does_not_take_large_window_brotli_for_brotli() {
        // The probe would otherwise reserve the declared window, up to 1 GiB,
        // for input that every brotli function of comprs rejects.
        let compressed = crate::brotli::compress_large_window(&text(1000), 30);
        assert_eq!(detect(&compressed), Format::Unknown);
        assert!(decompress(&compressed).is_err());
    }

    #[test]
    fn detect_unknown() {
        let data = b"this is not compressed data at all";
        assert_eq!(detect(data), Format::Unknown);
    }

    #[test]
    fn detect_empty() {
        assert_eq!(detect(b""), Format::Unknown);
    }

    #[test]
    fn detect_too_short() {
        assert_eq!(detect(&[0x00]), Format::Unknown);
    }

    #[test]
    fn decompress_auto_detect() {
        let original = b"Hello auto-detect!";

        // zstd
        let compressed = zstd::bulk::compress(original, 3).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());

        // gzip
        let compressed = crate::gzip::compress(original, None).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());

        // brotli
        let compressed = crate::brotli::compress(original, None).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());

        // lz4
        let compressed = crate::lz4::compress(original).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn decompress_unknown_format() {
        assert!(matches!(
            decompress(b"not compressed"),
            Err(ComprsError::UnknownFormat(_))
        ));
    }

    #[test]
    fn decompress_with_capacity_limits_the_output_of_every_format() {
        let original = text(10_000);
        let len = original.len();
        let legacy = lz4_legacy_frame(&original);
        for (compressed, context) in [
            (
                crate::zstd::compress(&original, None).unwrap(),
                "zstd decompress",
            ),
            (
                crate::gzip::compress(&original, None).unwrap(),
                "gzip decompress",
            ),
            (
                crate::brotli::compress(&original, None).unwrap(),
                "brotli decompress",
            ),
            (crate::lz4::compress(&original).unwrap(), "lz4 decompress"),
            (legacy, "lz4 decompress"),
        ] {
            // A limit far above the output reserves no memory up front.
            for capacity in [len, len + 1, usize::MAX] {
                assert_eq!(
                    decompress_with_capacity(&compressed, capacity).unwrap(),
                    original,
                    "{context} into {capacity} bytes"
                );
            }
            for capacity in [0, len - 1] {
                let err = decompress_with_capacity(&compressed, capacity).unwrap_err();
                assert_eq!(
                    err.to_string(),
                    format!("{context} exceeded maximum size of {capacity} bytes")
                );
            }
        }
    }

    #[test]
    fn decompress_with_capacity_keeps_errors_for_unknown_formats() {
        let compressed = crate::brotli::compress(&text(100_000), None).unwrap();
        for input in [&b"not compressed"[..], &compressed[..compressed.len() / 2]] {
            let err = decompress_with_capacity(input, 100_000).unwrap_err();
            assert!(
                err.to_string()
                    .starts_with("unable to detect compression format"),
                "{err}"
            );
        }
    }

    /// A skippable frame holding `payload`.
    fn skippable_frame(magic: u32, payload: &[u8]) -> Vec<u8> {
        [
            &magic.to_le_bytes()[..],
            &(payload.len() as u32).to_le_bytes(),
            payload,
        ]
        .concat()
    }

    /// A legacy LZ4 frame, as `lz4 -l` writes, holding `content`.
    fn lz4_legacy_frame(content: &[u8]) -> Vec<u8> {
        let block = lz4_flex::block::compress(content);
        [
            &0x184C_2102_u32.to_le_bytes()[..],
            &(block.len() as u32).to_le_bytes(),
            &block,
        ]
        .concat()
    }

    /// `len` bytes of pseudo-random data, the same for every `seed`.
    fn random(seed: u64, len: usize) -> Vec<u8> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                // xorshift64
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect()
    }

    /// Text that compresses well, as `len` bytes.
    fn text(len: usize) -> Vec<u8> {
        (0..)
            .flat_map(|i| format!("row {i}\n").into_bytes())
            .take(len)
            .collect()
    }

    #[test]
    fn detect_empty_brotli_stream() {
        let empty = crate::brotli::compress(b"", None).unwrap();
        assert_eq!(empty, [0x3b]);
        assert_eq!(detect(&empty), Format::Brotli);
        assert_eq!(decompress(&empty).unwrap(), b"");
    }

    #[test]
    fn detect_frames_after_skippable_frames() {
        let original = text(1000);
        let zstd = crate::zstd::compress(&original, None).unwrap();
        let lz4 = crate::lz4::compress(&original).unwrap();
        let skippable = [
            skippable_frame(0x184D_2A50, b""),
            skippable_frame(0x184D_2A5F, &[0x28, 0xB5, 0x2F, 0xFD]),
        ]
        .concat();
        for (frame, format) in [(&zstd, Format::Zstd), (&lz4, Format::Lz4)] {
            let input = [&skippable[..], frame].concat();
            assert_eq!(detect(&input), format);
            assert_eq!(decompress(&input).unwrap(), original);
        }
    }

    #[test]
    fn detect_needs_the_frame_after_skippable_frames() {
        let skippable = skippable_frame(0x184D_2A53, b"metadata");
        let brotli = crate::brotli::compress(b"brotli", None).unwrap();
        let gzip = crate::gzip::compress(b"gzip", None).unwrap();
        for input in [
            // Only the start of a skippable frame, or no frame after it.
            &skippable[..7],
            &skippable[..skippable.len() - 1],
            &skippable,
            // Skippable frames are no part of gzip and brotli streams.
            &[&skippable[..], &gzip].concat(),
            &[&skippable[..], &brotli].concat(),
            &[&skippable[..], &[0x28, 0xB5, 0x2F]].concat(),
        ] {
            assert_eq!(detect(input), Format::Unknown, "{input:?}");
        }
    }

    #[test]
    fn detect_lz4_legacy_frames() {
        let original = text(1000);
        let legacy = lz4_legacy_frame(&original);
        assert_eq!(detect(&legacy), Format::Lz4);
        assert_eq!(decompress(&legacy).unwrap(), original);
        let input = [skippable_frame(0x184D_2A50, b"x"), legacy].concat();
        assert_eq!(detect(&input), Format::Lz4);
    }

    #[test]
    fn detect_brotli_streams_of_any_quality_and_window() {
        for original in [&b""[..], b"a", &text(20_000), &random(1, 100_000)] {
            for quality in [0, 1, 6, 11] {
                for lg_window in [10, 16, 22, 24] {
                    let mut compressed = Vec::new();
                    {
                        let mut compressor = brotli::CompressorWriter::new(
                            &mut compressed,
                            4096,
                            quality,
                            lg_window,
                        );
                        compressor.write_all(original).unwrap();
                    }
                    assert_eq!(
                        detect(&compressed),
                        Format::Brotli,
                        "{} bytes at quality {quality}, window {lg_window}",
                        original.len()
                    );
                }
            }
        }
    }

    #[test]
    fn detect_the_start_of_a_brotli_stream() {
        // Compressed data decodes to more bytes than it holds after a few
        // hundred bytes.
        let compressed = crate::brotli::compress(&text(100_000), None).unwrap();
        assert_eq!(detect(&compressed[..256]), Format::Brotli);

        // Data that does not compress is stored in uncompressed meta-blocks,
        // as random data may seem to be: their start is brotli only once it
        // fills the 64 KiB that detection decodes.
        let compressed = crate::brotli::compress(&random(2, 100_000), None).unwrap();
        assert_eq!(
            detect(&compressed[..BROTLI_PROBE_SIZE - 1]),
            Format::Unknown
        );
        assert_eq!(detect(&compressed[..BROTLI_PROBE_SIZE]), Format::Brotli);
    }

    #[test]
    fn detect_rejects_data_after_a_brotli_stream() {
        let empty = crate::brotli::compress(b"", None).unwrap();
        let compressed = crate::brotli::compress(b"abc", None).unwrap();
        for stream in [&empty, &compressed] {
            let input = [&stream[..], b"trailing data"].concat();
            assert_eq!(detect(&input), Format::Unknown);
        }
    }

    #[test]
    fn detect_rarely_mistakes_random_data_for_brotli() {
        // The previous heuristic, which decoded one byte, reported about 6%
        // of these as brotli.
        for len in [4, 16, 64, 1024, 16 * 1024] {
            let brotli = (0..1000)
                .filter(|&seed| detect(&random(seed + 1, len)) == Format::Brotli)
                .count();
            assert_eq!(brotli, 0, "{len} bytes");
        }
    }

    #[test]
    fn detect_does_not_mistake_raw_deflate_for_brotli() {
        let original = text(43_890);
        for level in 0..=9 {
            let compressed = crate::gzip::deflate_compress(&original, Some(level)).unwrap();
            assert_eq!(detect(&compressed), Format::Unknown, "level {level}");
        }
    }

    #[test]
    fn decompress_reports_unknown_format_when_brotli_does_not_decode() {
        // The start of a stream that compresses well.
        let compressed = crate::brotli::compress(&text(100_000), None).unwrap();
        let truncated = &compressed[..compressed.len() / 2];
        // A stream that does not compress, corrupted after the 64 KiB that
        // detection decodes.
        let mut corrupted = crate::brotli::compress(&random(3, 100_000), None).unwrap();
        *corrupted.last_mut().unwrap() ^= 0xff;
        for input in [truncated, &corrupted] {
            assert_eq!(detect(input), Format::Brotli);
            let err = decompress(input).unwrap_err();
            assert!(matches!(err, ComprsError::UnknownFormat(_)), "{err:?}");
            assert!(
                err.to_string()
                    .starts_with("unable to detect compression format"),
                "{err}"
            );
        }
    }
}
