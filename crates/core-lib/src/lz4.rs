//! LZ4 frame compression and decompression.

use std::cell::Cell;
use std::hash::Hasher;
use std::io::Write;
use std::ops::RangeInclusive;

use lz4_flex::block::{decompress_into, decompress_into_with_dict};
use lz4_flex::frame::{BlockSize, Error as FrameError, FrameEncoder, FrameInfo};
use twox_hash::XxHash32;

use crate::ComprsError;

/// Magic number of an LZ4 frame.
pub(crate) const FRAME_MAGIC: u32 = 0x184D_2204;

/// Magic number of a legacy frame, as written by `lz4 -l`.
pub(crate) const LEGACY_MAGIC: u32 = 0x184C_2102;

/// Magic numbers of skippable frames, which hold user data for decoders to
/// skip. zstd has the same frames.
pub(crate) const SKIPPABLE_MAGIC: RangeInclusive<u32> = 0x184D_2A50..=0x184D_2A5F;

/// Fields of the FLG byte of the frame descriptor.
const FLG_VERSION_MASK: u8 = 0xC0;
const FLG_VERSION_01: u8 = 0x40;
const FLG_INDEPENDENT_BLOCKS: u8 = 0x20;
const FLG_BLOCK_CHECKSUM: u8 = 0x10;
const FLG_CONTENT_SIZE: u8 = 0x08;
const FLG_CONTENT_CHECKSUM: u8 = 0x04;
const FLG_RESERVED: u8 = 0x02;
const FLG_DICT_ID: u8 = 0x01;

/// Bits of the BD byte of the frame descriptor that hold the block maximum
/// size. The others are reserved.
const BD_BLOCK_SIZE_MASK: u8 = 0x70;

/// Block size bit that marks a block stored uncompressed.
const BLOCK_UNCOMPRESSED: u32 = 0x8000_0000;

/// How far back a linked block may refer to the content of earlier blocks.
const WINDOW_SIZE: usize = 64 * 1024;

/// Content size of the blocks of a legacy frame, except the last one.
const LEGACY_BLOCK_SIZE: usize = 8 * 1024 * 1024;

/// Largest block size of a legacy frame: the compression bound of
/// [`LEGACY_BLOCK_SIZE`]. Legacy frames have no end mark, so like the
/// reference decoder, a larger value ends the frame and is read as the next
/// frame's magic number.
const LEGACY_MAX_BLOCK_SIZE: u32 = (LEGACY_BLOCK_SIZE + LEGACY_BLOCK_SIZE / 255 + 16) as u32;

/// Largest block maximum size of an LZ4 frame: 4 MiB.
const MAX_BLOCK_SIZE: usize = 4 * 1024 * 1024;

/// Most bytes that the history of a [`Decoder`] holds: twice the window, so
/// that it moves the window to its start at most once per window of new
/// content, rather than once per block.
const HISTORY_CAPACITY: usize = 2 * WINDOW_SIZE;

/// Create a frame encoder writing to `writer`, in independent blocks of up
/// to `block_size` bytes.
///
/// The frames carry a content checksum, as the `lz4` CLI writes by default,
/// so decoders detect corrupted data.
pub(crate) fn frame_encoder<W: Write>(writer: W, block_size: BlockSize) -> FrameEncoder<W> {
    FrameEncoder::with_frame_info(
        FrameInfo::new()
            .block_size(block_size)
            .content_checksum(true),
        writer,
    )
}

/// Block maximum size of the frame that [`compress`] writes for `len` bytes:
/// 64 KiB for up to 64 KiB, 256 KiB for more.
///
/// The encoder needs two buffers of the block maximum size, and a decoder
/// one, so small input gets small blocks. Left to choose, lz4_flex would
/// pick the same sizes up to 256 KiB, but 4 MiB, the default of the `lz4`
/// CLI, for more. Against 4 MiB, 256 KiB blocks make 1 MB of text about
/// 0.3% larger, but need 16 times less memory, which makes compressing 1 MB
/// of repetitive data about 3 times faster.
fn compress_block_size(len: usize) -> BlockSize {
    if len <= 64 * 1024 {
        BlockSize::Max64KB
    } else {
        BlockSize::Max256KB
    }
}

/// The most bytes that [`compress`] writes for `len` bytes of input.
///
/// The encoder stores a block that does not compress as it is, behind its
/// 4-byte size, and every block but the last holds at least 64 KiB. The
/// frame adds 15 bytes: the magic number and the descriptor, the end mark
/// and the content checksum.
fn compress_bound(len: usize) -> usize {
    len + len.div_ceil(64 * 1024) * 4 + 15
}

/// Compress data using LZ4 frame format, in blocks of up to 256 KiB.
pub fn compress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    // Room for the whole frame, so the output is not reallocated, and
    // copied, before the last block.
    let mut output = Vec::with_capacity(compress_bound(data.len()));
    let mut encoder = frame_encoder(&mut output, compress_block_size(data.len()));
    encoder
        .write_all(data)
        .map_err(|e| ComprsError::Operation {
            context: "lz4 compress",
            source: e.into(),
        })?;
    encoder.finish().map_err(|e| ComprsError::Operation {
        context: "lz4 compress",
        source: e.into(),
    })?;

    Ok(crate::finish_output(output))
}

/// Decompress LZ4 frame-compressed data.
///
/// The input may hold several frames, including skippable and legacy ones.
/// The output is limited to [`crate::MAX_DECOMPRESSED_SIZE`] bytes.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    crate::require_input(data, "lz4")?;
    decompress_frames(data, crate::MAX_DECOMPRESSED_SIZE, "lz4 decompress")
}

/// Decompress LZ4 frame-compressed data with explicit capacity.
///
/// `capacity` limits the output size, as in [`decompress`].
pub fn decompress_with_capacity(data: &[u8], capacity: usize) -> Result<Vec<u8>, ComprsError> {
    crate::require_input(data, "lz4")?;
    decompress_frames(data, capacity, "lz4 decompress")
}

thread_local! {
    /// The scratch space of the last [`Decoder::push`] on the thread, kept
    /// for the next one if it holds at most [`MAX_BLOCK_SIZE`] bytes.
    static SCRATCH: Cell<Vec<u8>> = const { Cell::new(Vec::new()) };
}

/// Run `decode` with the thread's scratch space, and keep the scratch space
/// for the next call on the thread unless it has grown past
/// [`MAX_BLOCK_SIZE`].
///
/// The scratch space is initialised as far as earlier calls have grown it,
/// and holds what they decoded, which never reaches the output of this one:
/// the block decoder rejects match offsets before the start of the block or
/// its dictionary, and only the bytes that a block decodes to are copied
/// out. Taking it leaves an empty one for a nested call.
fn with_scratch<T>(decode: impl FnOnce(&mut Vec<u8>) -> T) -> T {
    let mut scratch = SCRATCH.try_with(Cell::take).unwrap_or_default();
    let result = decode(&mut scratch);
    // Put back after an error too, as it holds no state, but not the 8 MiB
    // scratch of a legacy frame, which is too much to keep around.
    if scratch.capacity() <= MAX_BLOCK_SIZE {
        // A thread that is exiting has no cache left; the scratch is dropped.
        let _ = SCRATCH.try_with(|cached| cached.set(scratch));
    }
    result
}

/// Decompress every frame in `data`, LZ4 and legacy frames alike, into one
/// output of at most `max_size` bytes, skipping skippable frames.
///
/// Fails with [`ComprsError::Truncated`] when the input is empty or ends
/// inside a frame, including a frame that lacks its end mark, and with
/// [`ComprsError::Corrupt`] when a frame is invalid or data that is not a
/// frame follows a frame.
pub(crate) fn decompress_frames(
    data: &[u8],
    max_size: usize,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    let mut output = Vec::new();
    output
        .try_reserve_exact(data.len().saturating_mul(4).min(max_size))
        .map_err(|e| operation_error(context, e.into()))?;
    let mut decoder = Decoder::new(max_size, context);
    decoder.push(data, &mut output)?;
    decoder.end()?;
    Ok(crate::finish_output(output))
}

/// Decodes a sequence of frames, LZ4 and legacy frames alike, skipping
/// skippable frames, from input that may arrive in pieces.
///
/// [`Decoder::push`] decodes the blocks that each piece completes. Between
/// pushes, the decoder keeps only the start of the next unit of the input,
/// at most a block and its checksum, and up to 128 KiB of the output of a
/// frame whose blocks refer to earlier ones. [`Decoder::end`] checks that
/// the input ended between frames.
pub(crate) struct Decoder {
    state: State,
    /// The LZ4 frame whose blocks the decoder reads.
    frame: Frame,
    /// The start of the unit that the input of the last push ended in: at
    /// most a block and its checksum, or a legacy block. Its capacity is
    /// kept for the next unit.
    pending: Vec<u8>,
    /// The end of what the current frame decoded before the output of the
    /// current push, for a frame of linked blocks: its last 64 KiB or less,
    /// which its next block may refer to, and up to 64 KiB before them.
    history: Vec<u8>,
    /// How many more bytes the output of all pushes may hold.
    remaining: usize,
    max_size: usize,
    context: &'static str,
    /// Whether the decoder has read a magic number: data that is not a
    /// frame is reported differently before and after.
    read_magic: bool,
}

/// The unit of input that a [`Decoder`] reads next. Each unit is decoded
/// once all of it has arrived, except the user data of a skippable frame,
/// which the decoder skips as it arrives.
#[derive(Clone, Copy)]
enum State {
    /// The magic number of a frame, or the end of the input.
    Magic,
    /// The descriptor of an LZ4 frame and its header checksum.
    Descriptor,
    /// A block size of an LZ4 frame, or its end mark.
    BlockSize,
    /// The block of this block size (as the frame stores it, with the bit
    /// that marks an uncompressed block), and its checksum if the frame has
    /// block checksums.
    Block(u32),
    /// The content checksum of an LZ4 frame, after its end mark.
    ContentChecksum,
    /// The size of the user data of a skippable frame.
    SkippableSize,
    /// The rest of the user data of a skippable frame: this many bytes.
    Skip(u32),
    /// A block size of a legacy frame, the magic number of the next frame,
    /// or the end of the input.
    LegacyBlockSize,
    /// A block of a legacy frame, of this many bytes.
    LegacyBlock(u32),
}

/// The fields of the LZ4 frame that a [`Decoder`] reads, from its
/// descriptor, and what the decoder has read of its content.
#[derive(Default)]
struct Frame {
    /// The FLG byte of the descriptor.
    flg: u8,
    /// The block maximum size.
    block_size: usize,
    content_size: Option<u64>,
    content_hasher: Option<XxHash32>,
    /// The size of the content decoded so far.
    decoded: u64,
}

/// Where one [`Decoder::push`] writes its output.
struct Sink<'a> {
    out: &'a mut Vec<u8>,
    /// Space that compressed blocks are decoded into before they are
    /// appended to `out`. Only its growth is zero-filled: it is reused for
    /// every block of every frame, and by the next push on the thread (see
    /// [`with_scratch`]), so a block costs time in proportion to its
    /// content, not to the block maximum size that its frame declares. The
    /// `lz4` CLI declares 4 MiB blocks by default, even for small content.
    scratch: &'a mut Vec<u8>,
    /// Where the output of the current frame starts in `out`. What the frame
    /// decoded before, in earlier pushes, is in [`Decoder::history`].
    frame_start: usize,
}

/// The content that a compressed block may refer to, as
/// [`Decoder::decode_block`] takes it.
enum Dict {
    /// None: the block is independent.
    None,
    /// [`Decoder::history`].
    History,
    /// The output of the current push from this index on.
    Output(usize),
}

impl Decoder {
    /// A decoder whose output is limited to `max_size` bytes in all, with
    /// `context` in its errors.
    pub(crate) fn new(max_size: usize, context: &'static str) -> Self {
        Self {
            state: State::Magic,
            frame: Frame::default(),
            pending: Vec::new(),
            history: Vec::new(),
            remaining: max_size,
            max_size,
            context,
            read_magic: false,
        }
    }

    /// Decode what `input` completes, appending the content of each block to
    /// `out`, and keep the start of the next unit for the next push.
    ///
    /// Fails as soon as the input is invalid, with the errors of
    /// [`decompress_frames`], or the output exceeds the size limit. A failed
    /// push leaves the decoder unusable.
    pub(crate) fn push(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), ComprsError> {
        with_scratch(|scratch| {
            let mut sink = Sink {
                frame_start: out.len(),
                out,
                scratch,
            };
            self.read(input, &mut sink)?;
            // A frame of linked blocks continues in a later push.
            let linked = self.frame.flg & FLG_INDEPENDENT_BLOCKS == 0;
            if linked && matches!(self.state, State::BlockSize | State::Block(_)) {
                self.extend_history(&sink.out[sink.frame_start..])?;
            }
            Ok(())
        })
    }

    /// Check that the input ended between frames, after a magic number at
    /// least: at the end of an LZ4 or skippable frame, or at a block
    /// boundary of a legacy frame, which has no end mark. Fails with
    /// [`ComprsError::Truncated`] otherwise.
    pub(crate) fn end(&self) -> Result<(), ComprsError> {
        let between_frames = matches!(self.state, State::Magic | State::LegacyBlockSize);
        if self.read_magic && between_frames && self.pending.is_empty() {
            Ok(())
        } else {
            Err(ComprsError::Truncated("lz4"))
        }
    }

    /// The heap memory that the decoder holds: the start of the next unit
    /// and the history. The scratch space belongs to the thread.
    pub(crate) fn memory_usage(&self) -> usize {
        self.pending.capacity() + self.history.capacity()
    }

    /// The capacity of [`Decoder::pending`].
    #[cfg(test)]
    pub(crate) fn pending_capacity(&self) -> usize {
        self.pending.capacity()
    }

    /// Decode the units of `input`, starting with the one that the last push
    /// ended in, and keep the start of the next one in `pending`.
    fn read(&mut self, mut input: &[u8], sink: &mut Sink) -> Result<(), ComprsError> {
        if !self.pending.is_empty()
            && let Some(need) = self.unit_len(&self.pending)
        {
            let (head, rest) = input.split_at((need - self.pending.len()).min(input.len()));
            input = rest;
            self.pending.extend_from_slice(head);
            if self.pending.len() < need {
                return self.check_partial_magic(&self.pending);
            }
            let unit = std::mem::take(&mut self.pending);
            let result = self.unit(&unit, sink);
            self.pending = unit;
            self.pending.clear();
            result?;
        }
        // The units that the input holds whole are decoded where they are.
        while let Some(need) = self.unit_len(input) {
            let Some((unit, rest)) = input.split_at_checked(need) else {
                self.check_partial_magic(input)?;
                self.pending
                    .try_reserve_exact(need)
                    .map_err(|e| operation_error(self.context, e.into()))?;
                self.pending.extend_from_slice(input);
                break;
            };
            input = rest;
            self.unit(unit, sink)?;
        }
        Ok(())
    }

    /// The length of the unit that the decoder reads next, given `input`,
    /// the input available for it. `None` if the length depends on input
    /// that has not arrived: the first byte of a descriptor, and the user
    /// data of a skippable frame, of which a unit is what has arrived.
    fn unit_len(&self, input: &[u8]) -> Option<usize> {
        Some(match self.state {
            State::Magic
            | State::BlockSize
            | State::ContentChecksum
            | State::SkippableSize
            | State::LegacyBlockSize => 4,
            State::Descriptor => descriptor_len(*input.first()?),
            State::Block(info) => {
                let checksum = if self.frame.flg & FLG_BLOCK_CHECKSUM != 0 {
                    4
                } else {
                    0
                };
                (info & !BLOCK_UNCOMPRESSED) as usize + checksum
            }
            State::Skip(_) if input.is_empty() => return None,
            State::Skip(len) => input.len().min(len as usize),
            State::LegacyBlock(len) => len as usize,
        })
    }

    /// Decode `unit`, the whole of the unit that the state expects.
    fn unit(&mut self, unit: &[u8], sink: &mut Sink) -> Result<(), ComprsError> {
        match self.state {
            State::Magic => self.magic(read_u32(unit)?),
            State::Descriptor => self.descriptor(unit, sink),
            State::BlockSize => self.block_size(read_u32(unit)?),
            State::Block(info) => self.block(info, unit, sink),
            State::ContentChecksum => {
                let checksum = read_u32(unit)?;
                if let Some(hasher) = self.frame.content_hasher.take()
                    && hasher.finish_32() != checksum
                {
                    return Err(self.error(FrameError::ContentChecksumError));
                }
                self.state = State::Magic;
                Ok(())
            }
            State::SkippableSize => {
                self.state = match read_u32(unit)? {
                    0 => State::Magic,
                    len => State::Skip(len),
                };
                Ok(())
            }
            State::Skip(len) => {
                // At most `len`, as unit_len() takes it.
                self.state = match len - unit.len() as u32 {
                    0 => State::Magic,
                    left => State::Skip(left),
                };
                Ok(())
            }
            State::LegacyBlockSize => {
                let len = read_u32(unit)?;
                // A legacy frame has no end mark: like in the reference
                // decoder, it ends before a block size above
                // LEGACY_MAX_BLOCK_SIZE, which is the next frame's magic
                // number.
                if len > LEGACY_MAX_BLOCK_SIZE {
                    return self.magic(len);
                }
                self.state = State::LegacyBlock(len);
                Ok(())
            }
            State::LegacyBlock(_) => {
                self.decode_block(unit, LEGACY_BLOCK_SIZE, Dict::None, sink)?;
                self.state = State::LegacyBlockSize;
                Ok(())
            }
        }
    }

    /// Start the frame of `magic`, or fail if it is no frame's magic number.
    fn magic(&mut self, magic: u32) -> Result<(), ComprsError> {
        self.state = match magic {
            FRAME_MAGIC => State::Descriptor,
            LEGACY_MAGIC => State::LegacyBlockSize,
            magic if SKIPPABLE_MAGIC.contains(&magic) => State::SkippableSize,
            _ => return Err(not_a_frame(!self.read_magic, self.context)),
        };
        self.frame = Frame::default();
        self.read_magic = true;
        Ok(())
    }

    /// Fail if `input`, the start of a magic number, cannot be the start of
    /// any frame's magic number.
    fn check_partial_magic(&self, input: &[u8]) -> Result<(), ComprsError> {
        match self.state {
            State::Magic if !is_magic_prefix(input) => {
                Err(not_a_frame(!self.read_magic, self.context))
            }
            _ => Ok(()),
        }
    }

    /// Start the LZ4 frame of the descriptor in `unit`, which holds the
    /// optional fields that its FLG byte declares and the header checksum.
    fn descriptor(&mut self, unit: &[u8], sink: &mut Sink) -> Result<(), ComprsError> {
        let mut input = unit;
        let [flg, bd] = *take_array::<2>(&mut input)?;
        let content_size = if flg & FLG_CONTENT_SIZE != 0 {
            Some(u64::from_le_bytes(*take_array(&mut input)?))
        } else {
            None
        };
        if flg & FLG_DICT_ID != 0 {
            take_array::<4>(&mut input)?;
        }
        let descriptor = &unit[..unit.len() - input.len()];
        let [header_checksum] = *take_array::<1>(&mut input)?;

        if flg & FLG_VERSION_MASK != FLG_VERSION_01 {
            return Err(self.error(FrameError::UnsupportedVersion(flg & FLG_VERSION_MASK)));
        }
        if flg & FLG_RESERVED != 0 || bd & !BD_BLOCK_SIZE_MASK != 0 {
            return Err(self.error(FrameError::ReservedBitsSet));
        }
        // Block maximum sizes 4 to 7 stand for 64 KB, 256 KB, 1 MB and 4 MB.
        let block_size = match (bd & BD_BLOCK_SIZE_MASK) >> 4 {
            id @ 4..=7 => 1 << (2 * id + 8),
            id => return Err(self.error(FrameError::UnsupportedBlocksize(id))),
        };
        // The second byte of the xxHash32 of the descriptor.
        if (XxHash32::oneshot(0, descriptor) >> 8) as u8 != header_checksum {
            return Err(self.error(FrameError::HeaderChecksumError));
        }
        if flg & FLG_DICT_ID != 0 {
            return Err(self.error(FrameError::DictionaryNotSupported));
        }

        self.frame = Frame {
            flg,
            block_size,
            content_size,
            content_hasher: (flg & FLG_CONTENT_CHECKSUM != 0).then(XxHash32::default),
            decoded: 0,
        };
        self.history.clear();
        sink.frame_start = sink.out.len();
        self.state = State::BlockSize;
        Ok(())
    }

    /// Read the block size `info` of an LZ4 frame, or its end mark.
    fn block_size(&mut self, info: u32) -> Result<(), ComprsError> {
        if info == 0 {
            // The end mark.
            let actual = self.frame.decoded;
            if let Some(expected) = self
                .frame
                .content_size
                .filter(|&expected| expected != actual)
            {
                return Err(self.error(FrameError::ContentLengthError { expected, actual }));
            }
            self.state = if self.frame.content_hasher.is_some() {
                State::ContentChecksum
            } else {
                State::Magic
            };
            return Ok(());
        }
        if (info & !BLOCK_UNCOMPRESSED) as usize > self.frame.block_size {
            return Err(self.error(FrameError::BlockTooBig));
        }
        self.state = State::Block(info);
        Ok(())
    }

    /// Decode the block of an LZ4 frame in `unit`, of block size `info`,
    /// after its checksum if the frame has block checksums.
    fn block(&mut self, info: u32, unit: &[u8], sink: &mut Sink) -> Result<(), ComprsError> {
        let mut input = unit;
        let block = take(&mut input, (info & !BLOCK_UNCOMPRESSED) as usize)?;
        if self.frame.flg & FLG_BLOCK_CHECKSUM != 0 {
            let checksum = take_u32(&mut input)?;
            if XxHash32::oneshot(0, block) != checksum {
                return Err(self.error(FrameError::BlockChecksumError));
            }
        }
        if info & BLOCK_UNCOMPRESSED != 0 {
            self.hash(block);
            self.reserve(sink.out, block.len())?;
            sink.out.extend_from_slice(block);
            self.frame.decoded += block.len() as u64;
        } else if self.frame.flg & FLG_INDEPENDENT_BLOCKS != 0 {
            self.decode_block(block, self.frame.block_size, Dict::None, sink)?;
        } else {
            // A linked block may refer to the last 64 KiB of content of the
            // earlier blocks of the same frame. Once this push has output
            // that much of the frame, the window is in the output. Before,
            // it starts in the history, to which the frame's output of this
            // push then moves, so that the window is in one piece.
            let in_output = sink.out.len() - sink.frame_start;
            if in_output > 0 && in_output < WINDOW_SIZE && !self.history.is_empty() {
                self.extend_history(&sink.out[sink.frame_start..])?;
                sink.frame_start = sink.out.len();
            }
            let dict = if sink.frame_start == sink.out.len() {
                Dict::History
            } else {
                Dict::Output(sink.out.len() - (sink.out.len() - sink.frame_start).min(WINDOW_SIZE))
            };
            self.decode_block(block, self.frame.block_size, dict, sink)?;
        }
        self.state = State::BlockSize;
        Ok(())
    }

    /// Decode the compressed `block`, whose content is at most `block_size`
    /// bytes and may refer to `dict`, append its content to the output and
    /// add it to the content checksum of the frame.
    fn decode_block(
        &mut self,
        block: &[u8],
        block_size: usize,
        dict: Dict,
        sink: &mut Sink,
    ) -> Result<(), ComprsError> {
        if sink.scratch.len() < block_size {
            let additional = block_size - sink.scratch.len();
            sink.scratch
                .try_reserve_exact(additional)
                .map_err(|e| operation_error(self.context, e.into()))?;
            sink.scratch.resize(block_size, 0);
        }
        let scratch = &mut sink.scratch[..block_size];
        let decoded = match dict {
            Dict::None => decompress_into(block, scratch),
            Dict::History => {
                let window = self.history.len().saturating_sub(WINDOW_SIZE);
                decompress_into_with_dict(block, scratch, &self.history[window..])
            }
            Dict::Output(start) => decompress_into_with_dict(block, scratch, &sink.out[start..]),
        };
        let len = decoded.map_err(|e| self.error(FrameError::DecompressionError(e)))?;
        let content = &sink.scratch[..len];
        // Hashing the block here rather than in the output, after the copy,
        // is measurably faster for large blocks.
        self.hash(content);
        self.reserve(sink.out, len)?;
        sink.out.extend_from_slice(content);
        self.frame.decoded += len as u64;
        Ok(())
    }

    /// Add `content` to the content checksum of the frame, if it has one.
    fn hash(&mut self, content: &[u8]) {
        // The hasher is taken out of the frame for the loop over `content`,
        // so that its state stays in registers.
        if let Some(mut hasher) = self.frame.content_hasher.take() {
            hasher.write(content);
            self.frame.content_hasher = Some(hasher);
        }
    }

    /// Append `content`, output of the current frame, to the history, which
    /// keeps at least the last [`WINDOW_SIZE`] bytes and at most
    /// [`HISTORY_CAPACITY`].
    fn extend_history(&mut self, content: &[u8]) -> Result<(), ComprsError> {
        if content.is_empty() {
            return Ok(());
        }
        let content = &content[content.len().saturating_sub(WINDOW_SIZE)..];
        if self.history.len() + content.len() > HISTORY_CAPACITY {
            // Keep the part of the window that `content` does not fill.
            let keep = WINDOW_SIZE - content.len();
            self.history.drain(..self.history.len() - keep);
        }
        self.history
            .try_reserve_exact(HISTORY_CAPACITY - self.history.len())
            .map_err(|e| operation_error(self.context, e.into()))?;
        self.history.extend_from_slice(content);
        Ok(())
    }

    /// Make room in `out` for `len` more bytes of output, within the size
    /// limit.
    fn reserve(&mut self, out: &mut Vec<u8>, len: usize) -> Result<(), ComprsError> {
        if len > self.remaining {
            return Err(ComprsError::SizeLimit {
                context: self.context,
                limit: self.max_size,
            });
        }
        out.try_reserve(len)
            .map_err(|e| operation_error(self.context, e.into()))?;
        self.remaining -= len;
        Ok(())
    }

    /// The error for invalid frame data.
    fn error(&self, e: FrameError) -> ComprsError {
        ComprsError::Corrupt {
            context: self.context,
            source: e.into(),
        }
    }
}

/// The error for a failed allocation.
fn operation_error(
    context: &'static str,
    source: Box<dyn std::error::Error + Send + Sync>,
) -> ComprsError {
    ComprsError::Operation { context, source }
}

/// The length of a frame descriptor whose FLG byte is `flg`, with its header
/// checksum: FLG, BD, the content size and the dictionary ID if FLG declares
/// them, and the checksum.
fn descriptor_len(flg: u8) -> usize {
    let content_size = if flg & FLG_CONTENT_SIZE != 0 { 8 } else { 0 };
    let dict_id = if flg & FLG_DICT_ID != 0 { 4 } else { 0 };
    3 + content_size + dict_id
}

/// Take the first `len` bytes of `input`, or fail if it ends before.
fn take<'a>(input: &mut &'a [u8], len: usize) -> Result<&'a [u8], ComprsError> {
    let (bytes, rest) = input
        .split_at_checked(len)
        .ok_or(ComprsError::Truncated("lz4"))?;
    *input = rest;
    Ok(bytes)
}

/// Take the first `N` bytes of `input`, or fail if it ends before.
fn take_array<'a, const N: usize>(input: &mut &'a [u8]) -> Result<&'a [u8; N], ComprsError> {
    let (bytes, rest) = input
        .split_first_chunk()
        .ok_or(ComprsError::Truncated("lz4"))?;
    *input = rest;
    Ok(bytes)
}

/// Take the little-endian `u32` at the start of `input`, or fail if it ends
/// before.
fn take_u32(input: &mut &[u8]) -> Result<u32, ComprsError> {
    take_array(input).map(|bytes| u32::from_le_bytes(*bytes))
}

/// Read `unit`, a little-endian `u32`.
fn read_u32(mut unit: &[u8]) -> Result<u32, ComprsError> {
    take_u32(&mut unit)
}

/// Whether `data`, shorter than a magic number, could be the start of one.
fn is_magic_prefix(data: &[u8]) -> bool {
    [FRAME_MAGIC, LEGACY_MAGIC]
        .into_iter()
        .chain(SKIPPABLE_MAGIC)
        .any(|magic| magic.to_le_bytes().starts_with(data))
}

/// The error for input that does not start with a frame's magic number,
/// either at the start of the input or after a frame.
fn not_a_frame(at_start: bool, context: &'static str) -> ComprsError {
    ComprsError::Corrupt {
        context,
        source: if at_start {
            FrameError::WrongMagicNumber.into()
        } else {
            "unexpected data after the end of a frame".into()
        },
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::time::{Duration, Instant};

    use lz4_flex::frame::{BlockMode, FrameDecoder};

    use super::*;

    #[test]
    fn decompress_rejects_empty_input() {
        assert!(matches!(
            decompress(&[]),
            Err(ComprsError::Truncated("lz4"))
        ));
        assert!(matches!(
            decompress_with_capacity(&[], 1024),
            Err(ComprsError::Truncated("lz4"))
        ));
    }

    /// Repetitive text of `len` bytes.
    fn text(len: usize) -> Vec<u8> {
        b"comprs decodes every LZ4 frame in its input. "
            .iter()
            .copied()
            .cycle()
            .take(len)
            .collect()
    }

    /// Compress `data` into one frame with the given settings.
    fn compress_with(data: &[u8], frame_info: FrameInfo) -> Vec<u8> {
        let mut encoder = FrameEncoder::with_frame_info(frame_info, Vec::new());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    /// A skippable frame carrying `payload`.
    fn skippable_frame(payload: &[u8]) -> Vec<u8> {
        let mut frame = 0x184D_2A53_u32.to_le_bytes().to_vec();
        frame.extend((payload.len() as u32).to_le_bytes());
        frame.extend(payload);
        frame
    }

    /// A frame with `descriptor` (FLG, BD and the optional fields), its header
    /// checksum, and then `blocks`, which end with the end mark and the
    /// content checksum, if any.
    fn frame_with_descriptor(descriptor: &[u8], blocks: &[u8]) -> Vec<u8> {
        let header_checksum = (XxHash32::oneshot(0, descriptor) >> 8) as u8;
        [
            &FRAME_MAGIC.to_le_bytes(),
            descriptor,
            &[header_checksum],
            blocks,
        ]
        .concat()
    }

    /// "abc" in an uncompressed block.
    const ABC_BLOCK: &[u8] = &[0x03, 0x00, 0x00, 0x80, b'a', b'b', b'c'];

    /// A compressed block that repeats the 4 bytes before it and adds "z".
    const REPEAT_BLOCK: &[u8] = &[0x05, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x10, b'z'];

    /// The end mark of a frame.
    const END_MARK: &[u8] = &[0x00; 4];

    /// The text that the frames written by the `lz4` CLI (v1.9.4) below hold.
    const CLI_TEXT: &[u8] = b"lz4 CLI frame, lz4 CLI frame, lz4 CLI frame.";

    /// `lz4 -c`: a content checksum (FLG 0x64), the CLI default.
    const CLI_FRAME: &[u8] = &[
        0x04, 0x22, 0x4d, 0x18, 0x64, 0x40, 0xa7, 0x1a, 0x00, 0x00, 0x00, 0xff, 0x00, 0x6c, 0x7a,
        0x34, 0x20, 0x43, 0x4c, 0x49, 0x20, 0x66, 0x72, 0x61, 0x6d, 0x65, 0x2c, 0x20, 0x0f, 0x00,
        0x05, 0x50, 0x72, 0x61, 0x6d, 0x65, 0x2e, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x4c, 0xd7, 0x16,
    ];

    /// `lz4 -c --no-frame-crc`: no checksum at all (FLG 0x60).
    const CLI_FRAME_WITHOUT_CHECKSUM: &[u8] = &[
        0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x82, 0x1a, 0x00, 0x00, 0x00, 0xff, 0x00, 0x6c, 0x7a,
        0x34, 0x20, 0x43, 0x4c, 0x49, 0x20, 0x66, 0x72, 0x61, 0x6d, 0x65, 0x2c, 0x20, 0x0f, 0x00,
        0x05, 0x50, 0x72, 0x61, 0x6d, 0x65, 0x2e, 0x00, 0x00, 0x00, 0x00,
    ];

    /// `lz4 -c -BX --content-size`: block checksums, the content size and a
    /// content checksum (FLG 0x7c).
    const CLI_FRAME_WITH_ALL_FIELDS: &[u8] = &[
        0x04, 0x22, 0x4d, 0x18, 0x7c, 0x40, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xb9,
        0x1a, 0x00, 0x00, 0x00, 0xff, 0x00, 0x6c, 0x7a, 0x34, 0x20, 0x43, 0x4c, 0x49, 0x20, 0x66,
        0x72, 0x61, 0x6d, 0x65, 0x2c, 0x20, 0x0f, 0x00, 0x05, 0x50, 0x72, 0x61, 0x6d, 0x65, 0x2e,
        0xeb, 0x49, 0xdc, 0xe6, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x4c, 0xd7, 0x16,
    ];

    /// `lz4 -c -l`: a legacy frame, which has no end mark.
    const CLI_LEGACY_FRAME: &[u8] = &[
        0x02, 0x21, 0x4c, 0x18, 0x1a, 0x00, 0x00, 0x00, 0xff, 0x00, 0x6c, 0x7a, 0x34, 0x20, 0x43,
        0x4c, 0x49, 0x20, 0x66, 0x72, 0x61, 0x6d, 0x65, 0x2c, 0x20, 0x0f, 0x00, 0x05, 0x50, 0x72,
        0x61, 0x6d, 0x65, 0x2e,
    ];

    #[test]
    fn compress_writes_a_content_checksum() {
        // FLG: version 01, independent blocks, content checksum.
        assert_eq!(compress(b"test").unwrap()[4], 0x64);
        assert_eq!(decompress(&compress(b"test").unwrap()).unwrap(), b"test");
    }

    #[test]
    fn compress_writes_blocks_of_at_most_256_kib() {
        // BD: blocks of up to 64 KB (0x40) or 256 KB (0x50). Left to choose,
        // lz4_flex would write 4 MB blocks for more than 256 KiB.
        for (len, bd) in [
            (0, 0x40),
            (64 * 1024, 0x40),
            (64 * 1024 + 1, 0x50),
            (1_000_000, 0x50),
        ] {
            let compressed = compress(&text(len)).unwrap();
            assert_eq!(compressed[5], bd, "{len} bytes");
            assert_eq!(decompress(&compressed).unwrap(), text(len));
            // A frame decoder other than this module's reads them too, and
            // checks every block against the block maximum size.
            let mut decoded = Vec::new();
            FrameDecoder::new(&compressed[..])
                .read_to_end(&mut decoded)
                .unwrap();
            assert_eq!(decoded, text(len), "{len} bytes");
        }
    }

    #[test]
    fn compress_bound_holds_data_that_does_not_compress() {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let random: Vec<u8> = (0..300_000)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 32) as u8
            })
            .collect();
        for len in [0, 1, 64 * 1024, 64 * 1024 + 1, 300_000] {
            let compressed = compress(&random[..len]).unwrap();
            // Every block is stored as it is.
            assert!(compressed.len() > len, "{len} bytes");
            assert!(compressed.len() <= compress_bound(len), "{len} bytes");
            assert_eq!(decompress(&compressed).unwrap(), &random[..len]);
        }
    }

    /// The length and the capacity of the scratch space that the thread
    /// keeps.
    fn kept_scratch() -> (usize, usize) {
        let scratch = SCRATCH.take();
        let size = (scratch.len(), scratch.capacity());
        SCRATCH.set(scratch);
        size
    }

    #[test]
    fn decompress_keeps_the_scratch_space_of_lz4_frames_only() {
        // Whatever the thread has decoded before.
        SCRATCH.take();
        let original = text(10_000);
        let mut frame = compress_with(
            &original,
            FrameInfo::new()
                .block_size(BlockSize::Max4MB)
                .content_checksum(true),
        );
        assert_eq!(decompress(&frame).unwrap(), original);
        // Kept at its length, not only its capacity: the next call
        // zero-fills the scratch space up to the block maximum size, so one
        // that was put back empty would cost every call 4 MiB of writes.
        let (len, _) = kept_scratch();
        assert!(len >= MAX_BLOCK_SIZE, "{len} bytes");

        // A legacy frame needs 8 MiB, which the thread does not keep.
        assert_eq!(decompress(CLI_LEGACY_FRAME).unwrap(), CLI_TEXT);
        let (_, capacity) = kept_scratch();
        assert!(capacity <= MAX_BLOCK_SIZE, "{capacity} bytes");

        // The scratch space of a frame that fails to decode is kept as well.
        let last = frame.len() - 1;
        frame[last] ^= 0x01;
        let err = decompress(&frame).unwrap_err();
        assert!(err.to_string().contains("ContentChecksumError"), "{err}");
        let (len, _) = kept_scratch();
        assert!(len >= MAX_BLOCK_SIZE, "{len} bytes");
    }

    #[test]
    fn decompress_detects_corrupted_block_data() {
        let original = text(1000);
        let mut compressed = compress(&original).unwrap();
        // The last 5 bytes of a block are literals, so flipping the byte
        // before the end mark and the checksum changes the decoded data.
        let last_literal = compressed.len() - 9;
        compressed[last_literal] ^= 0x01;
        let err = decompress(&compressed).unwrap_err();
        assert!(matches!(err, ComprsError::Corrupt { .. }));
        assert!(err.to_string().contains("ContentChecksumError"), "{err}");
    }

    #[test]
    fn decompress_reads_frames_from_other_encoders() {
        for frame in [
            CLI_FRAME,
            CLI_FRAME_WITHOUT_CHECKSUM,
            CLI_FRAME_WITH_ALL_FIELDS,
        ] {
            assert_eq!(decompress(frame).unwrap(), CLI_TEXT);
        }
        // Several blocks, also linked ones, and every optional field.
        let original = text(300_000);
        for frame_info in [
            FrameInfo::new(),
            FrameInfo::new()
                .block_size(BlockSize::Max64KB)
                .block_mode(BlockMode::Linked),
            FrameInfo::new()
                .block_size(BlockSize::Max64KB)
                .block_mode(BlockMode::Linked)
                .block_checksums(true)
                .content_checksum(true)
                .content_size(Some(original.len() as u64)),
        ] {
            let frame = compress_with(&original, frame_info);
            assert_eq!(decompress(&frame).unwrap(), original);
        }
    }

    #[test]
    fn decompress_reads_concatenated_frames() {
        let a = compress(b"Hello ").unwrap();
        let b = compress(b"World").unwrap();
        let input = [&a[..], &b[..], CLI_FRAME_WITHOUT_CHECKSUM].concat();
        let expected = [&b"Hello World"[..], CLI_TEXT].concat();
        assert_eq!(decompress(&input).unwrap(), expected);
        assert_eq!(
            decompress_with_capacity(&input, expected.len()).unwrap(),
            expected
        );
        // The limit covers all frames together.
        assert!(matches!(
            decompress_with_capacity(&input, expected.len() - 1),
            Err(ComprsError::SizeLimit { .. })
        ));

        let original = text(200_000);
        let linked = compress_with(
            &original,
            FrameInfo::new()
                .block_size(BlockSize::Max64KB)
                .block_mode(BlockMode::Linked),
        );
        assert_eq!(
            decompress(&[&linked[..], &linked[..]].concat()).unwrap(),
            original.repeat(2)
        );
    }

    #[test]
    fn decompress_links_blocks_within_their_frame_only() {
        // "abcd" in an uncompressed block.
        let abcd_block: &[u8] = &[0x04, 0x00, 0x00, 0x80, b'a', b'b', b'c', b'd'];
        // FLG 0x40: linked blocks.
        let frame = frame_with_descriptor(
            &[0x40, 0x40],
            &[abcd_block, REPEAT_BLOCK, END_MARK].concat(),
        );
        assert_eq!(decompress(&frame).unwrap(), b"abcdabcdz");

        // A block cannot refer to the frame before its own.
        let referring = frame_with_descriptor(&[0x40, 0x40], &[REPEAT_BLOCK, END_MARK].concat());
        let err = decompress(&[&frame[..], &referring[..]].concat()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "lz4 decompress failed: DecompressionError(OffsetOutOfBounds)"
        );
    }

    #[test]
    fn decompress_checks_every_field() {
        let checksum = &XxHash32::oneshot(0, b"abc").to_le_bytes()[..];
        let wrong_checksum: &[u8] = &[0xff; 4];
        let content_size = |size: u64| [&[0x68, 0x40][..], &size.to_le_bytes()].concat();
        // FLG 0x60: version 01, independent blocks. BD 0x40: blocks of up to
        // 64 KB.
        for (descriptor, blocks, error) in [
            (vec![0x60, 0x40], vec![ABC_BLOCK, END_MARK], None),
            (
                vec![0x20, 0x40],
                vec![ABC_BLOCK, END_MARK],
                Some("UnsupportedVersion(0)"),
            ),
            (
                vec![0x62, 0x40],
                vec![ABC_BLOCK, END_MARK],
                Some("ReservedBitsSet"),
            ),
            (
                vec![0x60, 0xc0],
                vec![ABC_BLOCK, END_MARK],
                Some("ReservedBitsSet"),
            ),
            (
                vec![0x60, 0x30],
                vec![ABC_BLOCK, END_MARK],
                Some("UnsupportedBlocksize(3)"),
            ),
            (
                vec![0x61, 0x40, 0x01, 0x00, 0x00, 0x00],
                vec![ABC_BLOCK, END_MARK],
                Some("DictionaryNotSupported"),
            ),
            (content_size(3), vec![ABC_BLOCK, END_MARK], None),
            (
                content_size(4),
                vec![ABC_BLOCK, END_MARK],
                Some("ContentLengthError { expected: 4, actual: 3 }"),
            ),
            (vec![0x70, 0x40], vec![ABC_BLOCK, checksum, END_MARK], None),
            (
                vec![0x70, 0x40],
                vec![ABC_BLOCK, wrong_checksum, END_MARK],
                Some("BlockChecksumError"),
            ),
            (vec![0x64, 0x40], vec![ABC_BLOCK, END_MARK, checksum], None),
            (
                vec![0x64, 0x40],
                vec![ABC_BLOCK, END_MARK, wrong_checksum],
                Some("ContentChecksumError"),
            ),
            // An uncompressed block of 64 KB + 1 byte.
            (
                vec![0x60, 0x40],
                vec![&[0x01, 0x00, 0x01, 0x80]],
                Some("BlockTooBig"),
            ),
            // A match of data before the start of the frame.
            (
                vec![0x60, 0x40],
                vec![REPEAT_BLOCK, END_MARK],
                Some("DecompressionError(OffsetOutOfBounds)"),
            ),
        ] {
            let input = frame_with_descriptor(&descriptor, &blocks.concat());
            match error {
                None => assert_eq!(decompress(&input).unwrap(), b"abc"),
                Some(error) => assert_eq!(
                    decompress(&input).unwrap_err().to_string(),
                    format!("lz4 decompress failed: {error}")
                ),
            }
        }

        let mut input = frame_with_descriptor(&[0x60, 0x40], &[ABC_BLOCK, END_MARK].concat());
        input[6] ^= 0x01;
        assert_eq!(
            decompress(&input).unwrap_err().to_string(),
            "lz4 decompress failed: HeaderChecksumError"
        );
    }

    #[test]
    fn decompress_time_does_not_grow_with_the_block_maximum_size() {
        // 20,000 frames that declare blocks of up to 4 MB but hold one byte
        // each. A decoder that zeroes a buffer of the block maximum size for
        // every frame writes 80 GB here.
        let blocks = [&[0x02, 0x00, 0x00, 0x00, 0x10, b'a'][..], END_MARK].concat();
        let input = frame_with_descriptor(&[0x60, 0x70], &blocks).repeat(20_000);
        let start = Instant::now();
        assert_eq!(decompress(&input).unwrap(), b"a".repeat(20_000));
        // A fraction of the time that writing 80 GB takes on any machine.
        let elapsed = start.elapsed();
        assert!(elapsed < Duration::from_secs(2), "took {elapsed:?}");
    }

    #[test]
    fn decompress_skips_skippable_frames() {
        let skippable = skippable_frame(b"metadata");
        let frame = compress(b"data").unwrap();
        for (input, frames) in [
            ([&skippable[..], &frame[..]].concat(), 1),
            ([&frame[..], &skippable[..]].concat(), 1),
            ([&frame[..], &skippable[..], &frame[..]].concat(), 2),
            ([&skippable[..], &skippable[..]].concat(), 0),
            (skippable_frame(b""), 0),
        ] {
            assert_eq!(decompress(&input).unwrap(), b"data".repeat(frames));
        }
    }

    #[test]
    fn decompress_reads_legacy_frames() {
        let frame = compress(CLI_TEXT).unwrap();
        for (input, frames) in [
            (CLI_LEGACY_FRAME.to_vec(), 1),
            ([CLI_LEGACY_FRAME, CLI_LEGACY_FRAME].concat(), 2),
            // A legacy frame ends where the next frame's magic number follows.
            ([CLI_LEGACY_FRAME, &frame[..]].concat(), 2),
            ([&frame[..], CLI_LEGACY_FRAME].concat(), 2),
        ] {
            assert_eq!(decompress(&input).unwrap(), CLI_TEXT.repeat(frames));
        }
    }

    #[test]
    fn decompress_reads_legacy_blocks_that_do_not_compress() {
        // A block of 8 MB of literals, as `lz4 -l` writes for data that does
        // not compress, is larger than its content.
        let content = text(LEGACY_BLOCK_SIZE);
        let mut block = vec![0xf0];
        block.extend(vec![255; (content.len() - 15) / 255]);
        block.push(((content.len() - 15) % 255) as u8);
        block.extend(&content);
        assert!(block.len() > LEGACY_BLOCK_SIZE);
        let input = [
            &LEGACY_MAGIC.to_le_bytes(),
            &(block.len() as u32).to_le_bytes()[..],
            &block,
        ]
        .concat();
        assert_eq!(decompress(&input).unwrap(), content);
    }

    #[test]
    fn decompress_reads_blocks_that_decode_to_nothing() {
        // FLG 0x60, BD 0x40 and the header checksum, an empty uncompressed
        // block, an uncompressed block holding "abc", and the end mark.
        let frame: &[u8] = &[
            0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x82, 0x00, 0x00, 0x00, 0x80, 0x03, 0x00, 0x00,
            0x80, b'a', b'b', b'c', 0x00, 0x00, 0x00, 0x00,
        ];
        assert_eq!(decompress(frame).unwrap(), b"abc");
        assert!(matches!(
            decompress(&frame[..frame.len() - 4]),
            Err(ComprsError::Truncated("lz4"))
        ));
    }

    #[test]
    fn decompress_rejects_truncated_input() {
        let compressed = compress(&text(1000)).unwrap();
        let skippable = skippable_frame(b"metadata");
        for frame in [
            &compressed[..],
            CLI_FRAME,
            CLI_FRAME_WITHOUT_CHECKSUM,
            CLI_FRAME_WITH_ALL_FIELDS,
            &skippable[..],
        ] {
            let after_frame = [&compressed[..], frame].concat();
            for len in 1..frame.len() {
                for input in [&frame[..len], &after_frame[..compressed.len() + len]] {
                    assert!(
                        matches!(decompress(input), Err(ComprsError::Truncated("lz4"))),
                        "frame of {} bytes cut to {len} bytes",
                        frame.len()
                    );
                }
            }
        }
    }

    #[test]
    fn decompress_rejects_data_after_the_last_frame() {
        let frame = compress(b"complete").unwrap();
        for trailing in [&b"garbage"[..], b"\n", &[0; 4]] {
            let input = [&frame[..], trailing].concat();
            let err = decompress(&input).unwrap_err();
            assert!(matches!(err, ComprsError::Corrupt { .. }), "{err}");
            assert_eq!(
                err.to_string(),
                "lz4 decompress failed: unexpected data after the end of a frame"
            );
        }
    }

    #[test]
    fn decompress_rejects_data_after_a_legacy_frame() {
        let input = [CLI_LEGACY_FRAME, b"garbage"].concat();
        assert_eq!(
            decompress(&input).unwrap_err().to_string(),
            "lz4 decompress failed: unexpected data after the end of a frame"
        );
    }

    #[test]
    fn decompress_reports_a_legacy_block_size_cut_short_as_truncated() {
        // Fewer than 4 bytes after a legacy block cannot be a block size or
        // a magic number: the reference decoder reports it as a read error.
        for trailing in [&b"\n"[..], &[0x1a, 0x00], &[0x1a, 0x00, 0x00]] {
            let input = [CLI_LEGACY_FRAME, trailing].concat();
            assert!(
                matches!(decompress(&input), Err(ComprsError::Truncated("lz4"))),
                "trailing {trailing:?}"
            );
        }
        assert!(matches!(
            decompress(&[0x02, 0x21, 0x4c, 0x18, 0x1a, 0x00]),
            Err(ComprsError::Truncated("lz4"))
        ));
    }

    #[test]
    fn decompress_rejects_input_that_is_not_a_frame() {
        for input in [&b"this is not lz4 data"[..], b"\n"] {
            let err = decompress(input).unwrap_err();
            assert_eq!(err.to_string(), "lz4 decompress failed: WrongMagicNumber");
        }
    }

    #[test]
    fn compress_decompress_round_trip() {
        let original = b"Hello from core-lib lz4!";
        let compressed = compress(original).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
