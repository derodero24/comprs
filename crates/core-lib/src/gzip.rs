//! gzip, zlib and raw deflate compression and decompression.

use std::io::{self, Write};

use flate2::read::{GzDecoder, MultiGzDecoder};
use flate2::write::{DeflateEncoder, GzEncoder, ZlibEncoder};
use flate2::{Compression, Decompress, DecompressError, FlushDecompress, GzBuilder, Status};

use crate::limited::LimitedVec;
use crate::{ComprsError, IntArg};

/// Default compression level for gzip/deflate (flate2 default = 6).
pub const DEFAULT_LEVEL: u32 = 6;

/// gzip compression levels: 0 (no compression) to 9 (best compression).
pub const LEVEL: IntArg<u32> = IntArg {
    name: "gzip compression level",
    min: 0,
    max: 9,
};

/// Raw deflate and zlib compression levels, the same as [`LEVEL`]. Both
/// formats go by `deflate`: raw deflate in the functions named after it,
/// such as [`deflate_compress`], and zlib in the Compression Streams
/// standard, as [`FlateWrapper::format_name`] calls it.
pub const DEFLATE_LEVEL: IntArg<u32> = IntArg {
    name: "deflate compression level",
    ..LEVEL
};

/// The modification time in the gzip header, in seconds since the Unix epoch.
pub const MTIME: IntArg<u32> = IntArg {
    name: "mtime",
    min: 0,
    max: u32::MAX,
};

/// Longest header filename, in bytes, that [`compress_with_header`] writes.
/// flate2's decoder, and therefore [`decompress`] and [`read_header`],
/// rejects longer header fields.
pub const MAX_FILENAME_LEN: usize = 65535;

/// Options for customizing the gzip header during compression.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GzipHeaderOptions {
    /// Must not contain NUL characters, which end the field in the header,
    /// and must be at most [`MAX_FILENAME_LEN`] bytes long.
    pub filename: Option<String>,
    pub mtime: Option<u32>,
}

/// Parsed gzip header metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GzipHeader {
    pub filename: Option<String>,
    pub mtime: u32,
    pub comment: Option<String>,
    pub os: u8,
    pub extra: Option<Vec<u8>>,
}

/// Compress data using gzip.
pub fn compress(data: &[u8], level: Option<u32>) -> Result<Vec<u8>, ComprsError> {
    let level = LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;

    let mut encoder = GzEncoder::new(Vec::with_capacity(data.len()), Compression::new(level));
    encoder
        .write_all(data)
        .map_err(|e| ComprsError::Operation {
            context: "gzip compress",
            source: e.into(),
        })?;
    encoder
        .finish()
        .map(crate::finish_output)
        .map_err(|e| ComprsError::Operation {
            context: "gzip compress",
            source: e.into(),
        })
}

/// Compress data using gzip with custom header metadata.
pub fn compress_with_header(
    data: &[u8],
    header: &GzipHeaderOptions,
    level: Option<u32>,
) -> Result<Vec<u8>, ComprsError> {
    let level = LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;
    let builder = header_builder(header)?;

    let mut encoder = builder.write(Vec::with_capacity(data.len()), Compression::new(level));
    encoder
        .write_all(data)
        .map_err(|e| ComprsError::Operation {
            context: "gzip compress with header",
            source: e.into(),
        })?;
    encoder
        .finish()
        .map(crate::finish_output)
        .map_err(|e| ComprsError::Operation {
            context: "gzip compress with header",
            source: e.into(),
        })
}

/// A gzip encoder builder that writes the header fields of `header`.
pub(crate) fn header_builder(header: &GzipHeaderOptions) -> Result<GzBuilder, ComprsError> {
    let mut builder = GzBuilder::new();
    if let Some(ref filename) = header.filename {
        validate_filename(filename)?;
        builder = builder.filename(filename.as_bytes());
    }
    if let Some(mtime) = header.mtime {
        builder = builder.mtime(mtime);
    }
    Ok(builder)
}

/// Check that `filename` can be stored in a gzip header and read back.
///
/// The header stores the filename NUL-terminated, and `GzBuilder::filename`
/// panics on a NUL byte instead of returning an error.
fn validate_filename(filename: &str) -> Result<(), ComprsError> {
    if filename.as_bytes().contains(&0) {
        return Err(ComprsError::InvalidArg(
            "gzip filename must not contain NUL characters".to_string(),
        ));
    }
    if filename.len() > MAX_FILENAME_LEN {
        return Err(ComprsError::InvalidArg(format!(
            "gzip filename must be at most {MAX_FILENAME_LEN} bytes long"
        )));
    }
    Ok(())
}

/// Read gzip header metadata without fully decompressing the data.
///
/// Data without a complete, valid gzip header fails with
/// [`ComprsError::InvalidArg`].
pub fn read_header(data: &[u8]) -> Result<GzipHeader, ComprsError> {
    let decoder = GzDecoder::new(data);
    // Not ComprsError::Corrupt, whose message has another form and which the
    // bindings report as a generic failure: the error keeps the message and
    // the code that it has always had.
    let header = decoder.header().ok_or_else(|| {
        ComprsError::InvalidArg("invalid gzip data: unable to parse header".to_string())
    })?;

    Ok(GzipHeader {
        filename: header
            .filename()
            .map(|b| String::from_utf8_lossy(b).into_owned()),
        mtime: header.mtime(),
        comment: header
            .comment()
            .map(|b| String::from_utf8_lossy(b).into_owned()),
        os: header.operating_system(),
        extra: header.extra().map(|b| b.to_vec()),
    })
}

/// Decompress gzip-compressed data.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    decompress_with_limit(data, crate::MAX_DECOMPRESSED_SIZE)
}

/// Decompress gzip-compressed data with explicit capacity.
pub fn decompress_with_capacity(data: &[u8], capacity: usize) -> Result<Vec<u8>, ComprsError> {
    decompress_with_limit(data, capacity)
}

fn decompress_with_limit(input: &[u8], max_size: usize) -> Result<Vec<u8>, ComprsError> {
    crate::require_input(input, "gzip")?;
    let decoder = MultiGzDecoder::new(input);
    let init_cap = initial_capacity(input, max_size);
    crate::decompress_with_limit(decoder, max_size, init_cap, "gzip decompress")
}

/// The most that deflate data can expand (about 1032:1).
const DEFLATE_MAX_EXPANSION: usize = 1032;

/// Largest output buffer that gzip decompression reserves before decoding.
/// Larger outputs grow the buffer as they are decoded.
const MAX_INITIAL_CAPACITY: usize = 64 * 1024 * 1024;

/// Initial output capacity for decompressing the gzip data in `input`.
///
/// Uses ISIZE from the gzip footer (last 4 bytes, little-endian uint32,
/// RFC 1952 §2.3.1) when it is set, and a 4x heuristic otherwise. ISIZE is
/// the size of the last member mod 2^32, so it wraps for data > 4GB, and
/// nothing verifies it until decoding ends. It is therefore only a hint: the
/// capacity never exceeds what `input` can expand to, [`MAX_INITIAL_CAPACITY`]
/// or `max_size`, so a forged trailer cannot reserve a huge buffer.
fn initial_capacity(input: &[u8], max_size: usize) -> usize {
    // Minimum gzip size: 10 (header) + 8 (trailer) = 18 bytes
    let isize_val = if input.len() >= 18 {
        u32::from_le_bytes(input[input.len() - 4..].try_into().unwrap()) as usize
    } else {
        0
    };
    let hint = if isize_val > 0 {
        isize_val
    } else {
        input.len().saturating_mul(4)
    };
    hint.min(input.len().saturating_mul(DEFLATE_MAX_EXPANSION))
        .min(MAX_INITIAL_CAPACITY)
        .min(max_size)
}

/// Compress data using raw deflate (no gzip header/trailer).
pub fn deflate_compress(data: &[u8], level: Option<u32>) -> Result<Vec<u8>, ComprsError> {
    let level = DEFLATE_LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;

    let mut encoder = DeflateEncoder::new(Vec::with_capacity(data.len()), Compression::new(level));
    encoder
        .write_all(data)
        .map_err(|e| ComprsError::Operation {
            context: "deflate compress",
            source: e.into(),
        })?;
    encoder
        .finish()
        .map(crate::finish_output)
        .map_err(|e| ComprsError::Operation {
            context: "deflate compress",
            source: e.into(),
        })
}

/// Decompress raw deflate-compressed data.
pub fn deflate_decompress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    deflate_decompress_with_limit(data, crate::MAX_DECOMPRESSED_SIZE)
}

/// Decompress raw deflate-compressed data with explicit capacity.
pub fn deflate_decompress_with_capacity(
    data: &[u8],
    capacity: usize,
) -> Result<Vec<u8>, ComprsError> {
    deflate_decompress_with_limit(data, capacity)
}

fn deflate_decompress_with_limit(input: &[u8], max_size: usize) -> Result<Vec<u8>, ComprsError> {
    // No up-front allocation from a size estimate: zlib-rs prepares all the
    // spare capacity it is offered, so the output grows as it fills instead.
    let mut output = LimitedVec::new(max_size, "deflate decompress");
    let mut inflater = Inflater::new(FlateWrapper::Raw);
    // Data after the end of the deflate stream is ignored.
    inflater
        .inflate(input, &mut output)
        .map_err(|e| output.error(e, "deflate decompress"))?;
    if !inflater.stream_end() {
        return Err(ComprsError::Truncated("deflate"));
    }
    Ok(crate::finish_output(output.take()))
}

/// Compress data in the zlib format (RFC 1950): deflate data after a 2-byte
/// header, followed by the Adler-32 checksum of the data. The Compression
/// Streams standard calls this format `deflate`; [`deflate_compress`] writes
/// raw deflate.
///
/// The level is validated with [`DEFLATE_LEVEL`].
pub fn zlib_compress(data: &[u8], level: Option<u32>) -> Result<Vec<u8>, ComprsError> {
    let level = DEFLATE_LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;

    let mut encoder = ZlibEncoder::new(Vec::with_capacity(data.len()), Compression::new(level));
    encoder
        .write_all(data)
        .map_err(|e| ComprsError::Operation {
            context: "deflate compress",
            source: e.into(),
        })?;
    encoder
        .finish()
        .map(crate::finish_output)
        .map_err(|e| ComprsError::Operation {
            context: "deflate compress",
            source: e.into(),
        })
}

/// The framing around a deflate stream (RFC 1951).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlateWrapper {
    /// Raw deflate, without a header or a checksum.
    Raw,
    /// zlib (RFC 1950): a 2-byte header, and the Adler-32 checksum of the
    /// data.
    Zlib,
    /// gzip (RFC 1952): a header, and the CRC-32 and the size of the data.
    Gzip,
}

impl FlateWrapper {
    /// The name of the format in the Compression Streams standard:
    /// `deflate-raw`, `deflate` for zlib, or `gzip`. The errors of
    /// [`decompress_strict`] and of
    /// [`crate::gzip_stream::StrictDecompressContext`] use it.
    pub fn format_name(self) -> &'static str {
        match self {
            FlateWrapper::Raw => "deflate-raw",
            FlateWrapper::Zlib => "deflate",
            FlateWrapper::Gzip => "gzip",
        }
    }

    /// The error context of [`decompress_strict`].
    fn decompress_context(self) -> &'static str {
        match self {
            FlateWrapper::Raw => "deflate-raw decompress",
            FlateWrapper::Zlib => "deflate decompress",
            FlateWrapper::Gzip => "gzip decompress",
        }
    }
}

/// Decompress raw deflate, zlib or gzip data, into at most `max_output`
/// bytes, and reject input that does not end at the end of the stream.
///
/// Unlike the other decoders of this module, which ignore data after the
/// end of a raw deflate stream or cannot tell a cut gzip member from
/// corrupt data, it fails with:
///
/// - [`ComprsError::Truncated`], with [`FlateWrapper::format_name`], for
///   input that ends before the end of the stream, including empty input;
/// - [`ComprsError::Corrupt`] for data after the end of the stream, for
///   invalid data, and for a zlib or gzip checksum or a gzip size that does
///   not match the data. zlib and gzip errors give zlib's reason, such as
///   `incorrect data check` for a checksum;
/// - [`ComprsError::SizeLimit`] for output that would exceed `max_output`.
///
/// gzip data may hold several members, as RFC 1952 allows: after the end of
/// a member, input that starts with the gzip magic bytes `1f 8b` starts
/// another member, which is decoded with a fresh decoder. Its output
/// follows the output of the members before it.
pub fn decompress_strict(
    data: &[u8],
    wrapper: FlateWrapper,
    max_output: usize,
) -> Result<Vec<u8>, ComprsError> {
    let context = wrapper.decompress_context();
    // No up-front allocation, as in deflate_decompress_with_limit.
    let mut output = LimitedVec::new(max_output, context);
    let mut decoder = StrictDecoder::new(wrapper);
    decoder.inflate(data, &mut output, context)?;
    decoder.finish()?;
    Ok(crate::finish_output(output.take()))
}

/// The two bytes that start a gzip member, ID1 and ID2 in RFC 1952.
const GZIP_ID1: u8 = 0x1f;
const GZIP_ID2: u8 = 0x8b;

/// The decoder of [`decompress_strict`] and
/// [`crate::gzip_stream::StrictDecompressContext`], which takes its input
/// in any number of pieces.
pub(crate) struct StrictDecoder {
    wrapper: FlateWrapper,
    state: StrictState,
}

enum StrictState {
    /// Inside the stream, or inside a gzip member.
    Inflating(Inflater),
    /// After the end of the stream, or of a gzip member.
    Ended,
    /// After the end of a gzip member and the first byte of another,
    /// [`GZIP_ID1`], which [`GZIP_ID2`] must follow.
    MemberStart,
}

impl StrictDecoder {
    pub(crate) fn new(wrapper: FlateWrapper) -> Self {
        Self {
            wrapper,
            state: StrictState::Inflating(Inflater::new(wrapper)),
        }
    }

    /// Whether the decoder holds an inflate stream: the stream or a gzip
    /// member has started and not ended.
    pub(crate) fn is_inflating(&self) -> bool {
        matches!(self.state, StrictState::Inflating(_))
    }

    /// Decode the next piece of the input into `sink`. An empty `input`
    /// only drains the decoder.
    ///
    /// Invalid data and data after the end of the stream fail with
    /// [`ComprsError::Corrupt`] with `context`.
    pub(crate) fn inflate(
        &mut self,
        mut input: &[u8],
        sink: &mut LimitedVec,
        context: &'static str,
    ) -> Result<(), ComprsError> {
        loop {
            match &mut self.state {
                StrictState::Inflating(inflater) => {
                    let consumed = inflater
                        .inflate(input, sink)
                        .map_err(|e| sink.error(e, context))?;
                    input = &input[consumed..];
                    if !inflater.stream_end() {
                        return Ok(());
                    }
                    self.state = StrictState::Ended;
                }
                // Between gzip members, or after the end of the stream.
                _ if input.is_empty() => return Ok(()),
                StrictState::Ended if self.wrapper == FlateWrapper::Gzip => match input {
                    // Another member, which the new decoder reads from its
                    // first byte.
                    [GZIP_ID1, GZIP_ID2, ..] => {
                        self.state = StrictState::Inflating(Inflater::new(FlateWrapper::Gzip));
                    }
                    [GZIP_ID1] => {
                        self.state = StrictState::MemberStart;
                        return Ok(());
                    }
                    _ => return Err(data_after_the_stream(context)),
                },
                StrictState::Ended => return Err(data_after_the_stream(context)),
                StrictState::MemberStart => {
                    if input[0] != GZIP_ID2 {
                        return Err(data_after_the_stream(context));
                    }
                    let mut inflater = Inflater::new(FlateWrapper::Gzip);
                    // The byte of the member that the previous input ended
                    // with, which produces no output.
                    inflater
                        .inflate(&[GZIP_ID1], sink)
                        .map_err(|e| sink.error(e, context))?;
                    self.state = StrictState::Inflating(inflater);
                }
            }
        }
    }

    /// Check that the input ended at the end of the stream, or of a gzip
    /// member: anything else fails with [`ComprsError::Truncated`].
    pub(crate) fn finish(&self) -> Result<(), ComprsError> {
        match self.state {
            StrictState::Ended => Ok(()),
            StrictState::Inflating(_) | StrictState::MemberStart => {
                Err(ComprsError::Truncated(self.wrapper.format_name()))
            }
        }
    }
}

/// The error of [`StrictDecoder`] for data after the end of the stream.
fn data_after_the_stream(context: &'static str) -> ComprsError {
    ComprsError::Corrupt {
        context,
        source: "unexpected data after the end of the compressed stream".into(),
    }
}

/// Upper bound for the first output window an inflate call gets, the buffer
/// size that flate2's own decoders use. Larger outputs grow it by doubling.
const INFLATE_BUF_SIZE: usize = 32 * 1024;

/// Deflate decoder that writes into a [`LimitedVec`] and tracks whether the
/// stream has ended. It reads the header and checks the checksums of the
/// stream's [`FlateWrapper`] (flate2's zlib-rs backend decodes gzip itself),
/// and decodes a single stream: a gzip member ends the stream.
///
/// flate2's `read` and `write` decoders treat input that stops before the
/// final block as a clean end of stream, so truncated input would decode
/// without an error.
pub(crate) struct Inflater {
    state: Decompress,
    wrapper: FlateWrapper,
    stream_end: bool,
}

impl Inflater {
    pub(crate) fn new(wrapper: FlateWrapper) -> Self {
        let state = match wrapper {
            FlateWrapper::Raw => Decompress::new(false),
            FlateWrapper::Zlib => Decompress::new(true),
            // The largest window, as for the other wrappers.
            FlateWrapper::Gzip => Decompress::new_gzip(15),
        };
        Self {
            state,
            wrapper,
            stream_end: false,
        }
    }

    /// Whether the end of the stream was decoded: the final deflate block,
    /// and the checksums that follow it.
    pub(crate) fn stream_end(&self) -> bool {
        self.stream_end
    }

    /// Inflate `input` into `sink` until the input is used up or the stream
    /// ends. An empty `input` only drains the decoder.
    ///
    /// Returns the number of input bytes consumed, which is less than
    /// `input.len()` only when the stream ended before the end of `input`.
    pub(crate) fn inflate(&mut self, mut input: &[u8], sink: &mut LimitedVec) -> io::Result<usize> {
        let input_len = input.len();
        // Size the first window by the input: zlib-rs prepares all the spare
        // capacity it is offered, and small outputs should stay small.
        let window = input_len.saturating_mul(4).clamp(64, INFLATE_BUF_SIZE);
        let wrapper = self.wrapper;
        while !self.stream_end {
            let total_in = self.state.total_in();
            let total_out = self.state.total_out();
            let (status, output_full) = sink.append_with(window, |buf| {
                let status = self
                    .state
                    .decompress_vec(input, buf, FlushDecompress::None)
                    .map_err(|e| invalid_stream(wrapper, &e))?;
                Ok((status, buf.len() == buf.capacity()))
            })?;
            let consumed = (self.state.total_in() - total_in) as usize;
            let produced = self.state.total_out() - total_out;
            input = &input[consumed..];

            if status == Status::StreamEnd {
                self.stream_end = true;
            } else if !output_full {
                // All output so far is drained; the decoder needs more input.
                if input.is_empty() {
                    break;
                }
                // zlib always makes progress while it has input and room for
                // output, so this only guards against looping forever.
                if consumed == 0 && produced == 0 {
                    return Err(corrupt_deflate_stream());
                }
            }
        }
        Ok(input_len - input.len())
    }
}

/// The error for the stream that `error` rejects.
///
/// Raw deflate gets flate2's message for every error, which the deflate
/// functions have always reported. zlib and gzip get zlib's message, which
/// tells a corrupt header, deflate data or checksum apart.
fn invalid_stream(wrapper: FlateWrapper, error: &DecompressError) -> io::Error {
    if error.needs_dictionary().is_some() {
        return io::Error::new(
            io::ErrorKind::InvalidInput,
            "zlib preset dictionaries are not supported",
        );
    }
    match (wrapper, error.message()) {
        (FlateWrapper::Zlib | FlateWrapper::Gzip, Some(message)) => {
            io::Error::new(io::ErrorKind::InvalidInput, message.to_owned())
        }
        _ => corrupt_deflate_stream(),
    }
}

/// The error flate2's own decoders report for invalid deflate data.
fn corrupt_deflate_stream() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "corrupt deflate stream")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compression_levels() {
        let data = b"Repeating data for compression level testing. ".repeat(100);
        let compressed = [0, 1, 9].map(|level| compress(&data, Some(level)).unwrap());
        for output in &compressed {
            assert_eq!(decompress(output).unwrap(), data);
        }
        let [stored, fast, best] = compressed.map(|output| output.len());
        // Level 0 stores the data without compressing it.
        assert!(stored > data.len(), "{stored} bytes");
        assert!(fast < data.len() / 10, "{fast} bytes");
        assert!(best <= fast, "{best} bytes at level 9, {fast} at level 1");
    }

    #[test]
    fn gzip_compress_rejects_level_above_9() {
        let err = compress(b"data", Some(10)).unwrap_err();
        assert!(matches!(err, ComprsError::InvalidArg(_)));
        assert_eq!(
            err.to_string(),
            "gzip compression level must be an integer between 0 and 9"
        );
    }

    #[test]
    fn gzip_compress_with_header_rejects_level_above_9() {
        let result = compress_with_header(
            b"data",
            &GzipHeaderOptions {
                filename: None,
                mtime: None,
            },
            Some(10),
        );
        assert!(matches!(result, Err(ComprsError::InvalidArg(_))));
    }

    #[test]
    fn deflate_compress_rejects_level_above_9() {
        let err = deflate_compress(b"data", Some(10)).unwrap_err();
        assert!(matches!(err, ComprsError::InvalidArg(_)));
        assert_eq!(
            err.to_string(),
            "deflate compression level must be an integer between 0 and 9"
        );
    }

    /// Options with only `filename` set.
    fn with_filename(filename: String) -> GzipHeaderOptions {
        GzipHeaderOptions {
            filename: Some(filename),
            mtime: None,
        }
    }

    #[test]
    fn compress_with_header_rejects_nul_in_filename() {
        for filename in ["a\0b", "\0", "name\0"] {
            let err =
                compress_with_header(b"data", &with_filename(filename.into()), None).unwrap_err();
            assert!(matches!(err, ComprsError::InvalidArg(_)), "{filename:?}");
            assert_eq!(
                err.to_string(),
                "gzip filename must not contain NUL characters"
            );
        }
    }

    #[test]
    fn compress_with_header_limits_filename_length() {
        let longest = "f".repeat(MAX_FILENAME_LEN);
        let compressed = compress_with_header(b"data", &with_filename(longest.clone()), None)
            .expect("the longest filename should be accepted");
        assert_eq!(read_header(&compressed).unwrap().filename, Some(longest));
        assert_eq!(decompress(&compressed).unwrap(), b"data");

        // The limit is in bytes: "é" takes two.
        for filename in [
            "f".repeat(MAX_FILENAME_LEN + 1),
            "é".repeat(MAX_FILENAME_LEN / 2 + 1),
        ] {
            let err = compress_with_header(b"data", &with_filename(filename), None).unwrap_err();
            assert!(matches!(err, ComprsError::InvalidArg(_)));
            assert_eq!(
                err.to_string(),
                "gzip filename must be at most 65535 bytes long"
            );
        }
    }

    #[test]
    fn compress_validates_level() {
        assert!(compress(b"test", Some(10)).is_err());
        assert!(compress(b"test", Some(9)).is_ok());
    }

    #[test]
    fn deflate_validates_level() {
        assert!(deflate_compress(b"test", Some(10)).is_err());
        assert!(deflate_compress(b"test", Some(9)).is_ok());
    }

    #[test]
    fn compress_decompress_round_trip() {
        let original = b"Hello from core-lib gzip!";
        let compressed = compress(original, None).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn deflate_decompress_rejects_truncated_input() {
        let compressed = deflate_compress(&b"truncated deflate ".repeat(500), None).unwrap();
        for len in [0, 1, compressed.len() / 2, compressed.len() - 1] {
            for result in [
                deflate_decompress(&compressed[..len]),
                deflate_decompress_with_capacity(&compressed[..len], 1 << 20),
            ] {
                assert!(
                    matches!(result, Err(ComprsError::Truncated("deflate"))),
                    "input of {len} bytes"
                );
            }
        }
    }

    #[test]
    fn deflate_decompress_reports_corrupt_input() {
        let err = deflate_decompress(&[0xff; 16]).unwrap_err();
        assert_eq!(
            err.to_string(),
            "deflate decompress failed: corrupt deflate stream"
        );
    }

    #[test]
    fn deflate_decompress_ignores_data_after_the_stream() {
        let mut input = deflate_compress(b"complete", None).unwrap();
        input.extend(b"trailing");
        assert_eq!(deflate_decompress(&input).unwrap(), b"complete");
    }

    #[test]
    fn deflate_decompress_enforces_capacity() {
        let compressed = deflate_compress(&[0u8; 4096], None).unwrap();
        assert_eq!(
            deflate_decompress_with_capacity(&compressed, 4096).unwrap(),
            [0u8; 4096]
        );
        assert!(matches!(
            deflate_decompress_with_capacity(&compressed, 4095),
            Err(ComprsError::SizeLimit { limit: 4095, .. })
        ));
    }

    #[test]
    fn decompress_rejects_empty_input() {
        assert!(matches!(
            decompress(&[]),
            Err(ComprsError::Truncated("gzip"))
        ));
        assert!(matches!(
            decompress_with_capacity(&[], 1024),
            Err(ComprsError::Truncated("gzip"))
        ));
    }

    #[test]
    fn deflate_compress_decompress_round_trip() {
        let original = b"Hello from core-lib deflate!";
        let compressed = deflate_compress(original, None).unwrap();
        let decompressed = deflate_decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    /// `input` with its last 4 bytes, the gzip ISIZE trailer, set to `isize`.
    fn with_isize(input: &[u8], isize: u32) -> Vec<u8> {
        let mut output = input.to_vec();
        let start = output.len() - 4;
        output[start..].copy_from_slice(&isize.to_le_bytes());
        output
    }

    #[test]
    fn initial_capacity_uses_isize() {
        let original = b"gzip ISIZE hint ".repeat(1000);
        let compressed = compress(&original, None).unwrap();
        assert_eq!(
            initial_capacity(&compressed, crate::MAX_DECOMPRESSED_SIZE),
            original.len()
        );
        assert_eq!(initial_capacity(&compressed, 100), 100);
    }

    #[test]
    fn initial_capacity_bounds_a_forged_isize() {
        // A small input cannot reserve more than it can expand to.
        let forged = with_isize(&compress(b"hello", None).unwrap(), u32::MAX);
        assert_eq!(
            initial_capacity(&forged, 1 << 33),
            forged.len() * DEFLATE_MAX_EXPANSION
        );
        assert!(matches!(
            decompress_with_capacity(&forged, 1 << 33),
            Err(ComprsError::Corrupt { .. })
        ));

        // A large one cannot reserve more than MAX_INITIAL_CAPACITY.
        let forged = with_isize(&[0; 100_000], u32::MAX);
        assert_eq!(initial_capacity(&forged, 1 << 33), MAX_INITIAL_CAPACITY);
    }
}
