//! LZ4 frame compression and decompression.

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

/// Decompress every frame in `data`, LZ4 and legacy frames alike, into one
/// output of at most `max_size` bytes, skipping skippable frames.
///
/// Fails with [`ComprsError::Truncated`] when the input ends inside a frame,
/// including a frame that lacks its end mark, and with
/// [`ComprsError::Corrupt`] when a frame is invalid or data that is not a
/// frame follows a frame.
pub(crate) fn decompress_frames(
    data: &[u8],
    max_size: usize,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    let mut decoder = Decoder {
        output: Vec::new(),
        scratch: Vec::new(),
        max_size,
        context,
    };
    decoder
        .output
        .try_reserve_exact(data.len().saturating_mul(4).min(max_size))
        .map_err(|e| decoder.operation_error(e.into()))?;
    let mut input = data;
    while !input.is_empty() {
        let at_start = input.len() == data.len();
        let magic = match input.first_chunk() {
            Some(bytes) => u32::from_le_bytes(*bytes),
            None if is_magic_prefix(input) => return Err(ComprsError::Truncated("lz4")),
            None => return Err(not_a_frame(at_start, context)),
        };
        input = &input[4..];
        match magic {
            FRAME_MAGIC => decoder.frame(&mut input)?,
            LEGACY_MAGIC => decoder.legacy_frame(&mut input)?,
            magic if SKIPPABLE_MAGIC.contains(&magic) => {
                // The size of the user data, then the user data.
                let len = take_u32(&mut input)?;
                take(&mut input, len as usize)?;
            }
            _ => return Err(not_a_frame(at_start, context)),
        }
    }
    Ok(crate::finish_output(decoder.output))
}

/// Decodes the frames of one input into one output.
struct Decoder {
    output: Vec<u8>,
    /// Space that compressed blocks are decoded into before they are appended
    /// to `output`. It is zeroed once and reused for every block of every
    /// frame, so a block costs time in proportion to its content, not to the
    /// block maximum size that its frame declares.
    scratch: Vec<u8>,
    max_size: usize,
    context: &'static str,
}

impl Decoder {
    /// Decode the LZ4 frame that follows its magic number at the start of
    /// `input`, and advance `input` past the frame.
    fn frame(&mut self, input: &mut &[u8]) -> Result<(), ComprsError> {
        let descriptor_start = *input;
        let [flg, bd] = *take_array::<2>(input)?;
        let content_size = if flg & FLG_CONTENT_SIZE != 0 {
            Some(u64::from_le_bytes(*take_array(input)?))
        } else {
            None
        };
        if flg & FLG_DICT_ID != 0 {
            take_array::<4>(input)?;
        }
        let descriptor = &descriptor_start[..descriptor_start.len() - input.len()];
        let [header_checksum] = *take_array::<1>(input)?;

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

        let frame_start = self.output.len();
        let mut content_hasher = (flg & FLG_CONTENT_CHECKSUM != 0).then(XxHash32::default);
        loop {
            let block_info = take_u32(input)?;
            if block_info == 0 {
                // The end mark.
                break;
            }
            let len = (block_info & !BLOCK_UNCOMPRESSED) as usize;
            if len > block_size {
                return Err(self.error(FrameError::BlockTooBig));
            }
            let block = take(input, len)?;
            if flg & FLG_BLOCK_CHECKSUM != 0 {
                let checksum = take_u32(input)?;
                if XxHash32::oneshot(0, block) != checksum {
                    return Err(self.error(FrameError::BlockChecksumError));
                }
            }
            if block_info & BLOCK_UNCOMPRESSED != 0 {
                if let Some(hasher) = &mut content_hasher {
                    hasher.write(block);
                }
                self.reserve(block.len())?;
                self.output.extend_from_slice(block);
            } else {
                // A linked block may refer to the content of earlier blocks
                // of the same frame.
                let dict_start = (flg & FLG_INDEPENDENT_BLOCKS == 0)
                    .then(|| frame_start.max(self.output.len().saturating_sub(WINDOW_SIZE)));
                self.decode_block(block, block_size, dict_start, content_hasher.as_mut())?;
            }
        }

        let actual = (self.output.len() - frame_start) as u64;
        if let Some(expected) = content_size.filter(|&expected| expected != actual) {
            return Err(self.error(FrameError::ContentLengthError { expected, actual }));
        }
        if let Some(hasher) = content_hasher {
            let checksum = take_u32(input)?;
            if hasher.finish_32() != checksum {
                return Err(self.error(FrameError::ContentChecksumError));
            }
        }
        Ok(())
    }

    /// Decode the legacy frame that follows its magic number at the start of
    /// `input`, and advance `input` past the frame.
    ///
    /// A legacy frame has no end mark: like in the reference decoder, it ends
    /// with the input or before a block size above [`LEGACY_MAX_BLOCK_SIZE`],
    /// which is the next frame's magic number. Input that ends inside a block
    /// size is truncated, as the reference decoder reports it.
    fn legacy_frame(&mut self, input: &mut &[u8]) -> Result<(), ComprsError> {
        loop {
            let Some(bytes) = input.first_chunk() else {
                return if input.is_empty() {
                    Ok(())
                } else {
                    Err(ComprsError::Truncated("lz4"))
                };
            };
            let len = u32::from_le_bytes(*bytes);
            if len > LEGACY_MAX_BLOCK_SIZE {
                return Ok(());
            }
            *input = &input[4..];
            let block = take(input, len as usize)?;
            self.decode_block(block, LEGACY_BLOCK_SIZE, None, None)?;
        }
    }

    /// Decode the compressed `block`, whose content is at most `block_size`
    /// bytes, append its content to the output and add it to
    /// `content_hasher`. A linked block may refer to the output from
    /// `dict_start` on.
    fn decode_block(
        &mut self,
        block: &[u8],
        block_size: usize,
        dict_start: Option<usize>,
        content_hasher: Option<&mut XxHash32>,
    ) -> Result<(), ComprsError> {
        if self.scratch.len() < block_size {
            let additional = block_size - self.scratch.len();
            self.scratch
                .try_reserve_exact(additional)
                .map_err(|e| self.operation_error(e.into()))?;
            self.scratch.resize(block_size, 0);
        }
        let scratch = &mut self.scratch[..block_size];
        let decoded = match dict_start {
            Some(start) => decompress_into_with_dict(block, scratch, &self.output[start..]),
            None => decompress_into(block, scratch),
        };
        let len = decoded.map_err(|e| self.error(FrameError::DecompressionError(e)))?;
        // Hashing the block here rather than in the output, after the copy,
        // is measurably faster for large blocks.
        if let Some(hasher) = content_hasher {
            hasher.write(&self.scratch[..len]);
        }
        self.reserve(len)?;
        self.output.extend_from_slice(&self.scratch[..len]);
        Ok(())
    }

    /// Make room for `len` more bytes of output, within the size limit.
    fn reserve(&mut self, len: usize) -> Result<(), ComprsError> {
        if len > self.max_size - self.output.len() {
            return Err(ComprsError::SizeLimit {
                context: self.context,
                limit: self.max_size,
            });
        }
        self.output
            .try_reserve(len)
            .map_err(|e| self.operation_error(e.into()))
    }

    /// The error for invalid frame data.
    fn error(&self, e: FrameError) -> ComprsError {
        ComprsError::Corrupt {
            context: self.context,
            source: e.into(),
        }
    }

    /// The error for a failed allocation.
    fn operation_error(&self, source: Box<dyn std::error::Error + Send + Sync>) -> ComprsError {
        ComprsError::Operation {
            context: self.context,
            source,
        }
    }
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
