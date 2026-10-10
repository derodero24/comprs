//! Fuzzer-chosen parameters: output limits, dictionaries, compression levels,
//! how to feed a stream context and damage to a valid compressed stream.

use std::io::Write;

use comprs_core::ComprsError;
use libfuzzer_sys::arbitrary::{Result, Unstructured};
use lz4_flex::frame::{BlockMode, BlockSize, FrameEncoder, FrameInfo};

use crate::format::{Format, Stream};
use crate::heap;

/// Largest output limit that the decompression targets choose. Small limits
/// keep the targets fast and make overshooting them easy to detect.
pub const MAX_LIMIT: usize = 1024 * 1024;

// The zstd decoders bound the window of a frame by their output limit, but
// accept windows of up to 8 MiB under any limit (#676). Under the limits of
// the targets, which stay within 8 MiB, a frame's window therefore never
// makes a smaller limit fail where a larger one succeeds: only its output
// does, as the targets check.
const _: () = assert!(MAX_LIMIT <= 8 * 1024 * 1024);

/// Largest dictionary that the targets build from the input.
pub const MAX_DICT_LEN: usize = 4096;

/// Largest chunk that a [`ChunkPlan`] passes to `transform`.
const MAX_CHUNK_LEN: usize = 64 * 1024;

/// Most chunks that a [`ChunkPlan`] splits its input into: longer input gets
/// longer chunks, so that a run takes a bounded number of calls.
const MAX_CHUNKS: usize = 256;

/// Read an output limit in `0..=MAX_LIMIT`.
pub fn limit(u: &mut Unstructured) -> Result<usize> {
    u.int_in_range(0..=MAX_LIMIT)
}

/// Read a dictionary for the dictionary variant of `format`, or `None` for
/// the plain variant.
pub fn dict<'a>(u: &mut Unstructured<'a>, format: Format) -> Result<Option<&'a [u8]>> {
    if !format.has_dict() || !u.arbitrary::<bool>()? {
        return Ok(None);
    }
    let len = u.int_in_range(0..=MAX_DICT_LEN)?;
    Ok(Some(u.bytes(len)?))
}

/// Read a compression level for `format` (`None` for the default level),
/// within the range that [`Format::compress`] accepts. The zstd range stops
/// at 12: higher levels only make the compressor slower, and above 19 a
/// stream context writes windows over 8 MiB, which the decoders reject under
/// the limits of `round_trip`.
pub fn level(u: &mut Unstructured, format: Format) -> Result<Option<i32>> {
    if !u.arbitrary::<bool>()? {
        return Ok(None);
    }
    Ok(Some(match format {
        Format::Zstd => u.int_in_range(-7..=12)?,
        Format::Gzip | Format::Deflate => u.int_in_range(0..=9)?,
        Format::Brotli => u.int_in_range(0..=11)?,
        Format::Lz4 => 0,
    }))
}

/// Read how many times to repeat the data that a target compresses: a short
/// input repeated makes data that spans several blocks of a format, or that
/// compresses as well as a decompression bomb. Most counts are small, so
/// that most data stays short and fast to compress; the rest are powers of
/// two up to 2^16.
pub fn repeat_count(u: &mut Unstructured) -> Result<usize> {
    if u.ratio(1, 8)? {
        Ok(1 << u.int_in_range(0..=16)?)
    } else {
        u.int_in_range(1..=16)
    }
}

/// `data` repeated `count` times, or as many times as fits in `max_len`
/// bytes (at least once).
pub fn repeat(data: &[u8], count: usize, max_len: usize) -> Vec<u8> {
    let fits = max_len.checked_div(data.len()).unwrap_or(count);
    data.repeat(count.min(fits).max(1))
}

/// Data length above which [`affordable_level`] lowers slow levels.
const SLOW_LEVEL_MAX_LEN: usize = 16 * 1024;

/// `level`, or a faster level where compressing at `level` would slow the
/// target down without adding coverage: under the sanitizer, brotli
/// qualities 10 and 11 take up to a second on a few hundred KiB, and several
/// milliseconds for each `flush` of a stream.
pub fn affordable_level(
    format: Format,
    level: Option<i32>,
    len: usize,
    streamed: bool,
) -> Option<i32> {
    match (format, level) {
        (Format::Brotli, Some(quality)) if streamed || len > SLOW_LEVEL_MAX_LEN => {
            Some(quality.min(9))
        }
        _ => level,
    }
}

/// Settings of an LZ4 frame that lz4_flex's frame encoder writes, where
/// comprs-core's encoder always writes independent blocks of 64 or 256 KiB
/// with a content checksum: every block maximum size, linked blocks, and
/// each optional field.
#[derive(Debug)]
pub struct Lz4Frame {
    info: FrameInfo,
    /// Declare the content size in the descriptor.
    content_size: bool,
}

impl Lz4Frame {
    /// Read the settings of a frame for data of `format`: `None` for the
    /// encoder of comprs-core, always for formats other than LZ4.
    pub fn arbitrary(u: &mut Unstructured, format: Format) -> Result<Option<Self>> {
        if format != Format::Lz4 || !u.arbitrary::<bool>()? {
            return Ok(None);
        }
        let block_size = *u.choose(&[
            BlockSize::Max64KB,
            BlockSize::Max256KB,
            BlockSize::Max1MB,
            BlockSize::Max4MB,
        ])?;
        let block_mode = if u.arbitrary::<bool>()? {
            BlockMode::Linked
        } else {
            BlockMode::Independent
        };
        let info = FrameInfo::new()
            .block_size(block_size)
            .block_mode(block_mode)
            .block_checksums(u.arbitrary()?)
            .content_checksum(u.arbitrary()?);
        Ok(Some(Self {
            info,
            content_size: u.arbitrary()?,
        }))
    }

    /// Compress `data` into one frame with these settings.
    pub fn compress(&self, data: &[u8]) -> Vec<u8> {
        let info = self
            .info
            .clone()
            .content_size(self.content_size.then_some(data.len() as u64));
        let mut encoder = FrameEncoder::with_frame_info(info, Vec::new());
        encoder
            .write_all(data)
            .and_then(|()| encoder.finish().map_err(Into::into))
            .unwrap_or_else(|error| panic!("lz4_flex compression with {self:?} failed: {error}"))
    }
}

/// How a stream context is fed: input chunks with sizes cycled from a short
/// list, with empty chunks and `flush` calls in between.
#[derive(Debug)]
pub struct ChunkPlan {
    steps: Vec<Step>,
}

#[derive(Debug)]
struct Step {
    /// Size of the chunk, at least 1 so that the input is used up.
    len: usize,
    /// Pass an empty chunk before this one.
    empty_first: bool,
    /// Call `flush` after this chunk.
    flush_after: bool,
}

impl ChunkPlan {
    pub fn arbitrary(u: &mut Unstructured) -> Result<Self> {
        let count = u.int_in_range(1..=8)?;
        let steps = (0..count)
            .map(|_| {
                Ok(Step {
                    len: u.int_in_range(1..=MAX_CHUNK_LEN)?,
                    empty_first: u.ratio(1, 8)?,
                    flush_after: u.ratio(1, 4)?,
                })
            })
            .collect::<Result<_>>()?;
        Ok(Self { steps })
    }

    /// The same plan without `flush` calls between chunks, for the buffered
    /// LZ4 decompression context: its `flush` decodes the buffered input as
    /// complete frames, so it ends the input.
    pub fn without_flushes(mut self) -> Self {
        for step in &mut self.steps {
            step.flush_after = false;
        }
        self
    }

    /// Feed `input` to `stream`, then call `flush` and, if the context has
    /// one, `finish`, collecting the output of every call.
    ///
    /// Stops at the first error unless `keep_going` is set, in which case the
    /// remaining calls are made anyway (a caller may keep using a context
    /// after an error) and the first error is returned. Fails the target if
    /// the output ever grows past `limit` bytes, or if a finished context
    /// accepts more input.
    pub fn run(
        &self,
        stream: &mut dyn Stream,
        input: &[u8],
        limit: usize,
        keep_going: bool,
    ) -> std::result::Result<Vec<u8>, ComprsError> {
        self.run_measured(stream, input, limit, keep_going, &|_| {})
    }

    /// [`ChunkPlan::run`], passing `check` the heap memory that each call
    /// used, as [`heap::measure`] reports it.
    pub fn run_measured(
        &self,
        stream: &mut dyn Stream,
        input: &[u8],
        limit: usize,
        keep_going: bool,
        check: &dyn Fn(usize),
    ) -> std::result::Result<Vec<u8>, ComprsError> {
        let mut run = Run {
            output: Vec::new(),
            error: None,
            limit,
            check,
        };
        let min_len = input.len().div_ceil(MAX_CHUNKS);
        let mut rest = input;
        for step in self.steps.iter().cycle() {
            if step.empty_first && !run.call(|| stream.transform(&[])) && !keep_going {
                break;
            }
            if rest.is_empty() {
                break;
            }
            let (chunk, tail) = rest.split_at(step.len.max(min_len).min(rest.len()));
            rest = tail;
            if !run.call(|| stream.transform(chunk)) && !keep_going {
                break;
            }
            if step.flush_after && !run.call(|| stream.flush()) && !keep_going {
                break;
            }
        }
        if run.error.is_none() || keep_going {
            run.call(|| stream.flush());
            let (finished, peak) = heap::measure(|| stream.finish());
            check(peak);
            if let Some(result) = finished {
                run.record(result);
                assert!(
                    matches!(stream.transform(b"x"), Err(ComprsError::StreamFinished(_))),
                    "a finished stream accepted more input"
                );
            }
        }
        match run.error {
            Some(error) => Err(error),
            None => Ok(run.output),
        }
    }
}

/// Output and first error of [`ChunkPlan::run`].
struct Run<'a> {
    output: Vec<u8>,
    error: Option<ComprsError>,
    limit: usize,
    check: &'a dyn Fn(usize),
}

impl Run<'_> {
    /// Make one call to the stream and record its result; returns whether
    /// it succeeded.
    fn call(&mut self, f: impl FnOnce() -> std::result::Result<Vec<u8>, ComprsError>) -> bool {
        let (result, peak) = heap::measure(f);
        (self.check)(peak);
        self.record(result)
    }

    /// Record the result of one call; returns whether it succeeded.
    fn record(&mut self, result: std::result::Result<Vec<u8>, ComprsError>) -> bool {
        match result {
            Ok(chunk) => {
                assert!(
                    self.output.len() + chunk.len() <= self.limit,
                    "stream output of {} bytes exceeds the limit of {} bytes",
                    self.output.len() + chunk.len(),
                    self.limit
                );
                self.output.extend_from_slice(&chunk);
                true
            }
            Err(error) => {
                self.error.get_or_insert(error);
                false
            }
        }
    }
}

/// Changes to a valid compressed stream: flipped bits and a truncation.
#[derive(Debug)]
pub struct Damage {
    /// Offsets (wrapped to the stream length) and the bits to flip there.
    flips: Vec<(usize, u8)>,
    /// Length to cut the stream to (wrapped to the stream length).
    truncate: Option<usize>,
}

impl Damage {
    pub fn arbitrary(u: &mut Unstructured) -> Result<Self> {
        let count = u.int_in_range(0..=4)?;
        let flips = (0..count)
            .map(|_| Ok((usize::from(u.arbitrary::<u16>()?), u.int_in_range(1..=255)?)))
            .collect::<Result<_>>()?;
        let truncate = if u.ratio(1, 4)? {
            Some(usize::from(u.arbitrary::<u16>()?))
        } else {
            None
        };
        Ok(Self { flips, truncate })
    }

    pub fn apply(&self, data: &mut Vec<u8>) {
        if let Some(len) = self.truncate {
            data.truncate(len % (data.len() + 1));
        }
        if data.is_empty() {
            return;
        }
        for &(offset, bits) in &self.flips {
            let len = data.len();
            data[offset % len] ^= bits;
        }
    }
}
