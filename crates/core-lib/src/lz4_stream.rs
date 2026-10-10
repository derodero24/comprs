//! LZ4 frame streaming compression and decompression.

use std::io::Write;

use lz4_flex::frame::{BlockSize, FrameEncoder};

use crate::lz4::Decoder;
use crate::{ComprsError, MemoryUsage};

/// Block maximum size of the stream encoder: 64 KiB, the default of the
/// reference LZ4 frame library.
///
/// A block is written once it is full, so the smallest block size has the
/// lowest latency and the smallest encoder state. Left to choose, lz4_flex
/// would size the blocks from the first chunk: 4 MiB for a chunk of more
/// than 256 KiB.
const BLOCK_SIZE: BlockSize = BlockSize::Max64KB;

/// Heap memory of a frame encoder, whose blocks are always [`BLOCK_SIZE`]
/// (64 KiB): a 16 KiB hash table, and an input block and an output block
/// that it allocates with the first data.
const ENCODER_STATE_SIZE: usize =
    16 * 1024 + 64 * 1024 + lz4_flex::block::get_maximum_output_size(64 * 1024);

/// Streaming LZ4 frame compression context.
///
/// Uses `FrameEncoder` internally to compress into independent blocks of up
/// to 64 KiB: each `transform()` call takes the bytes that the encoder has
/// written to its output Vec so far, the blocks completed by then. The frame
/// carries a content checksum, like the output of [`crate::lz4::compress`].
pub struct CompressContext {
    encoder: Option<FrameEncoder<Vec<u8>>>,
}

impl CompressContext {
    pub fn new() -> Self {
        Self {
            encoder: Some(crate::lz4::frame_encoder(Vec::new(), BLOCK_SIZE)),
        }
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("lz4 stream"))?;

        encoder
            .write_all(chunk)
            .map_err(|e| ComprsError::Operation {
                context: "lz4 stream compress",
                source: e.into(),
            })?;

        Ok(std::mem::take(encoder.get_mut()))
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or(ComprsError::StreamFinished("lz4 stream"))?;

        encoder.flush().map_err(|e| ComprsError::Operation {
            context: "lz4 stream flush",
            source: e.into(),
        })?;

        Ok(std::mem::take(encoder.get_mut()))
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let encoder = self
            .encoder
            .take()
            .ok_or(ComprsError::StreamFinished("lz4 stream"))?;

        // The encoder's Vec holds only what earlier calls have not returned.
        encoder.finish().map_err(|e| ComprsError::Operation {
            context: "lz4 stream finish",
            source: e.into(),
        })
    }
}

impl Default for CompressContext {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryUsage for CompressContext {
    fn memory_usage(&self) -> usize {
        self.encoder.as_ref().map_or(0, |encoder| {
            ENCODER_STATE_SIZE + encoder.get_ref().capacity()
        })
    }
}

/// Streaming LZ4 frame decompression context.
///
/// Like [`crate::lz4::decompress`], it decodes every frame of its input, LZ4
/// and legacy frames alike, and skips skippable frames. It works in one of
/// two modes:
///
/// - Buffered, as [`DecompressContext::new`] creates it: `transform` keeps
///   the input and returns an empty Vec, and `flush` decodes the input kept
///   since the last `flush`, which must end between frames. The output limit
///   applies to each `flush` on its own, not to the stream as a whole.
/// - Incremental, as [`DecompressContext::incremental`] creates it:
///   `transform` returns the content of the blocks that its chunk completes,
///   and fails as soon as the input is invalid; `flush` returns an empty Vec;
///   `finish` checks that the input ended between frames. The output limit
///   applies to the whole stream. The context keeps at most one block and its
///   checksum of input, and for frames of linked blocks up to 128 KiB of
///   their output.
pub struct DecompressContext {
    mode: Mode,
}

enum Mode {
    Buffered(Buffered),
    Incremental(Incremental),
}

/// The state of a buffered context.
struct Buffered {
    /// Compressed input that has not been decoded yet; `None` once the
    /// stream is finished.
    buffer: Option<Vec<u8>>,
    max_output_size: usize,
    /// Whether any compressed input has been received.
    received_input: bool,
}

/// The state of an incremental context.
enum Incremental {
    Decoding(Decoder),
    /// A `transform` call failed with this error, which the later calls
    /// report again: the decoder cannot resume after invalid input.
    Failed(ComprsError),
    /// `finish` was called.
    Finished,
}

impl DecompressContext {
    /// A buffered context, whose output is limited to `max_output_size`
    /// bytes (256 MB by default) per `flush`.
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            mode: Mode::Buffered(Buffered {
                buffer: Some(Vec::new()),
                max_output_size: max_size,
                received_input: false,
            }),
        })
    }

    /// An incremental context, whose output is limited to `max_output_size`
    /// bytes (256 MB by default) in all.
    pub fn incremental(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        Ok(Self {
            mode: Mode::Incremental(Incremental::Decoding(Decoder::new(
                max_size,
                "lz4 stream decompress",
            ))),
        })
    }

    /// Take a chunk of compressed data.
    ///
    /// In buffered mode, keep it and return an empty Vec. In incremental
    /// mode, decode it and return the content of the blocks that it
    /// completes; fail as soon as the input is invalid or the output exceeds
    /// the limit, with the errors of a buffered [`Self::flush`].
    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        match &mut self.mode {
            Mode::Buffered(buffered) => {
                buffered
                    .buffer
                    .as_mut()
                    .ok_or(ComprsError::StreamFinished("lz4 stream"))?
                    .extend_from_slice(chunk);
                buffered.received_input |= !chunk.is_empty();
                Ok(Vec::new())
            }
            Mode::Incremental(incremental) => {
                let decoder = incremental.decoder()?;
                let mut output = Vec::new();
                match decoder.push(chunk, &mut output) {
                    Ok(()) => Ok(output),
                    Err(error) => {
                        *incremental = Incremental::Failed(error.duplicate());
                        Err(error)
                    }
                }
            }
        }
    }

    /// In buffered mode, decompress all buffered data and return the
    /// result. In incremental mode, return an empty Vec, or fail with the
    /// error of an earlier call.
    ///
    /// In buffered mode, like [`crate::lz4::decompress`], it decodes every
    /// frame, skipping skippable frames. Fails with [`ComprsError::Truncated`]
    /// when no input was received at all or the input ends inside a frame,
    /// and with [`ComprsError::Corrupt`] when a frame is invalid or data that
    /// is not a frame follows a frame. Calling it again after a successful
    /// call returns an empty Vec.
    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        match &mut self.mode {
            Mode::Buffered(buffered) => buffered.flush(),
            Mode::Incremental(incremental) => incremental.decoder().map(|_| Vec::new()),
        }
    }

    /// End the stream: later calls fail.
    ///
    /// In buffered mode, decompress the remaining buffered data, like
    /// [`Self::flush`], and release the buffer. In incremental mode, return
    /// an empty Vec, or fail with [`ComprsError::Truncated`] unless the input
    /// ended between frames, including empty input, and with the error of an
    /// earlier call that failed.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        match &mut self.mode {
            Mode::Buffered(buffered) => {
                let output = buffered.flush();
                buffered.buffer = None;
                output
            }
            Mode::Incremental(incremental) => {
                match std::mem::replace(incremental, Incremental::Finished) {
                    Incremental::Decoding(decoder) => decoder.end().map(|()| Vec::new()),
                    Incremental::Failed(error) => Err(error),
                    Incremental::Finished => Err(ComprsError::StreamFinished("lz4 stream")),
                }
            }
        }
    }

    /// The capacity of the incremental decoder's buffer for the start of the
    /// next unit of input.
    #[cfg(test)]
    fn pending_capacity(&self) -> usize {
        match &self.mode {
            Mode::Incremental(Incremental::Decoding(decoder)) => decoder.pending_capacity(),
            _ => 0,
        }
    }
}

impl Buffered {
    fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let buffer = self
            .buffer
            .as_mut()
            .ok_or(ComprsError::StreamFinished("lz4 stream"))?;
        if buffer.is_empty() {
            if !self.received_input {
                return Err(ComprsError::Truncated("lz4"));
            }
            return Ok(Vec::new());
        }

        let result =
            crate::lz4::decompress_frames(buffer, self.max_output_size, "lz4 stream decompress")?;
        buffer.clear();
        Ok(result)
    }
}

impl Incremental {
    /// The decoder, or the error that the stream has ended with.
    fn decoder(&mut self) -> Result<&mut Decoder, ComprsError> {
        match self {
            Incremental::Decoding(decoder) => Ok(decoder),
            Incremental::Failed(error) => Err(error.duplicate()),
            Incremental::Finished => Err(ComprsError::StreamFinished("lz4 stream")),
        }
    }
}

impl MemoryUsage for DecompressContext {
    fn memory_usage(&self) -> usize {
        match &self.mode {
            Mode::Buffered(buffered) => buffered.buffer.as_ref().map_or(0, Vec::capacity),
            Mode::Incremental(Incremental::Decoding(decoder)) => decoder.memory_usage(),
            Mode::Incremental(_) => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use lz4_flex::frame::{BlockMode, FrameDecoder, FrameInfo};
    use twox_hash::XxHash32;

    use super::*;

    #[test]
    fn decompress_context_rejects_empty_input() {
        let mut ctx = DecompressContext::new(None).unwrap();
        ctx.transform(&[]).unwrap();
        assert!(matches!(ctx.flush(), Err(ComprsError::Truncated("lz4"))));
    }

    #[test]
    fn decompress_context_finish_decodes_and_ends_the_stream() {
        let compressed = crate::lz4::compress(b"lz4 stream").unwrap();
        let mut ctx = DecompressContext::new(None).unwrap();
        ctx.transform(&compressed).unwrap();
        assert!(ctx.memory_usage() >= compressed.len());
        assert_eq!(ctx.finish().unwrap(), b"lz4 stream");
        assert_eq!(ctx.memory_usage(), 0);
        assert!(matches!(
            ctx.transform(&compressed),
            Err(ComprsError::StreamFinished("lz4 stream"))
        ));
        assert!(matches!(ctx.flush(), Err(ComprsError::StreamFinished(_))));
        assert!(matches!(ctx.finish(), Err(ComprsError::StreamFinished(_))));

        // After flush(), nothing is left to decode.
        let mut ctx = DecompressContext::new(None).unwrap();
        ctx.transform(&compressed).unwrap();
        assert_eq!(ctx.flush().unwrap(), b"lz4 stream");
        assert!(ctx.finish().unwrap().is_empty());

        let mut ctx = DecompressContext::new(None).unwrap();
        assert!(matches!(ctx.finish(), Err(ComprsError::Truncated("lz4"))));
        assert!(matches!(ctx.finish(), Err(ComprsError::StreamFinished(_))));
    }

    #[test]
    fn compress_context_reports_the_encoder_state() {
        let mut ctx = CompressContext::new();
        ctx.transform(b"lz4 stream").unwrap();
        assert!(ctx.memory_usage() >= ENCODER_STATE_SIZE);
        ctx.finish().unwrap();
        assert_eq!(ctx.memory_usage(), 0);
    }

    #[test]
    fn compress_context_writes_64_kib_blocks() {
        // Left to choose, lz4_flex would size the blocks from the first
        // chunk: 4 MB for a chunk of 1 MiB and a byte.
        let data = b"lz4 stream in 64 KiB blocks. ".repeat(40_000);
        let (first, rest) = data.split_at(1024 * 1024 + 1);
        let mut ctx = CompressContext::new();
        let mut compressed = ctx.transform(first).unwrap();
        // The blocks that the chunk fills come out right away: all of it but
        // its last byte, as the output closed with an end mark and the
        // content checksum shows. With 4 MB blocks, the encoder would keep
        // the whole chunk and return the frame header alone.
        let filled = &data[..1024 * 1024];
        let checksum = XxHash32::oneshot(0, filled).to_le_bytes();
        let closed = [&compressed[..], &[0; 4], &checksum].concat();
        assert_eq!(crate::lz4::decompress(&closed).unwrap(), filled);
        compressed.extend(ctx.transform(rest).unwrap());
        compressed.extend(ctx.finish().unwrap());
        // BD: blocks of up to 64 KB.
        assert_eq!(compressed[5], 0x40);
        assert_eq!(crate::lz4::decompress(&compressed).unwrap(), data);
        // A frame decoder other than crate::lz4's reads it too, and checks
        // every block against the block maximum size.
        let mut decoded = Vec::new();
        FrameDecoder::new(&compressed[..])
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn compress_context_returns_everything_the_encoder_writes() {
        // Several 64 KiB blocks, some of them stored uncompressed.
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let data: Vec<u8> = (0..200_000u32)
            .map(|i| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                if i / 50_000 % 2 == 0 {
                    state as u8
                } else {
                    (i % 7) as u8
                }
            })
            .collect();
        for chunk_size in [1, 1000, 64 * 1024] {
            let mut ctx = CompressContext::new();
            let mut encoder = crate::lz4::frame_encoder(Vec::new(), BLOCK_SIZE);
            let mut compressed = Vec::new();
            for chunk in data.chunks(chunk_size) {
                compressed.extend(ctx.transform(chunk).unwrap());
                encoder.write_all(chunk).unwrap();
                // The context keeps no output that it has returned.
                assert_eq!(ctx.memory_usage(), ENCODER_STATE_SIZE);
            }
            compressed.extend(ctx.flush().unwrap());
            compressed.extend(ctx.finish().unwrap());
            encoder.flush().unwrap();
            assert_eq!(
                compressed,
                encoder.finish().unwrap(),
                "chunk size {chunk_size}"
            );
            assert_eq!(crate::lz4::decompress(&compressed).unwrap(), data);
        }
    }

    #[test]
    fn decompress_context_flush_is_repeatable() {
        let compressed = crate::lz4::compress(b"lz4 stream").unwrap();
        let mut ctx = DecompressContext::new(None).unwrap();
        ctx.transform(&compressed).unwrap();
        assert_eq!(ctx.flush().unwrap(), b"lz4 stream");
        assert!(ctx.flush().unwrap().is_empty());
    }

    /// Compress `data` with a [`CompressContext`], in chunks of 1000 bytes.
    fn compress_in_chunks(data: &[u8]) -> Vec<u8> {
        let mut ctx = CompressContext::new();
        let mut compressed = Vec::new();
        for chunk in data.chunks(1000) {
            compressed.extend(ctx.transform(chunk).unwrap());
        }
        compressed.extend(ctx.flush().unwrap());
        compressed.extend(ctx.finish().unwrap());
        compressed
    }

    /// Decompress `input` with a [`DecompressContext`], in chunks of 7 bytes.
    fn decompress_in_chunks(
        input: &[u8],
        max_output_size: Option<f64>,
    ) -> Result<Vec<u8>, ComprsError> {
        let mut ctx = DecompressContext::new(max_output_size).unwrap();
        for chunk in input.chunks(7) {
            assert!(ctx.transform(chunk).unwrap().is_empty());
        }
        ctx.flush()
    }

    #[test]
    fn compress_context_writes_a_content_checksum() {
        let original = b"lz4 stream with a content checksum. ".repeat(100);
        let mut compressed = compress_in_chunks(&original);
        // FLG: version 01, independent blocks, content checksum.
        assert_eq!(compressed[4], 0x64);
        assert_eq!(decompress_in_chunks(&compressed, None).unwrap(), original);

        // The last 5 bytes of a block are literals.
        let last_literal = compressed.len() - 9;
        compressed[last_literal] ^= 0x01;
        let err = decompress_in_chunks(&compressed, None).unwrap_err();
        assert!(err.to_string().contains("ContentChecksumError"), "{err}");
    }

    #[test]
    fn decompress_context_reads_every_frame() {
        let a = compress_in_chunks(b"Hello ");
        let b = crate::lz4::compress(b"World").unwrap();
        let skippable = [&0x184D_2A50_u32.to_le_bytes()[..], &[3, 0, 0, 0, 1, 2, 3]].concat();
        let input = [
            &skippable[..],
            &a[..],
            &skippable[..],
            &b[..],
            &skippable[..],
        ]
        .concat();
        assert_eq!(decompress_in_chunks(&input, None).unwrap(), b"Hello World");
        assert_eq!(
            decompress_in_chunks(&input, Some(11.0)).unwrap(),
            b"Hello World"
        );
        assert!(matches!(
            decompress_in_chunks(&input, Some(10.0)),
            Err(ComprsError::SizeLimit { limit: 10, .. })
        ));
    }

    #[test]
    fn decompress_context_rejects_truncated_input() {
        let frame = compress_in_chunks(&b"truncated lz4 stream. ".repeat(100));
        let concatenated = [&frame[..], &frame[..]].concat();
        for len in [1, 4, 7, frame.len() / 2, frame.len() - 8, frame.len() - 1] {
            for input in [&frame[..len], &concatenated[..frame.len() + len]] {
                assert!(
                    matches!(
                        decompress_in_chunks(input, None),
                        Err(ComprsError::Truncated("lz4"))
                    ),
                    "input of {} bytes",
                    input.len()
                );
            }
        }
    }

    #[test]
    fn decompress_context_rejects_data_after_the_last_frame() {
        let mut input = compress_in_chunks(b"complete");
        input.extend(b"trailing");
        let err = decompress_in_chunks(&input, None).unwrap_err();
        assert_eq!(
            err.to_string(),
            "lz4 stream decompress failed: unexpected data after the end of a frame"
        );
    }

    #[test]
    fn decompress_context_limits_each_flush() {
        // Buffered, the limit applies to each flush() on its own, as it
        // always has for callers that flush() as they go.
        let frame = crate::lz4::compress(&vec![7; 800_000]).unwrap();
        let mut ctx = DecompressContext::new(Some(1_000_000.0)).unwrap();
        for _ in 0..2 {
            assert!(ctx.transform(&frame).unwrap().is_empty());
            assert_eq!(ctx.flush().unwrap().len(), 800_000);
        }
        let frame = crate::lz4::compress(&vec![7; 1_000_001]).unwrap();
        assert!(ctx.transform(&frame).unwrap().is_empty());
        assert!(matches!(
            ctx.flush(),
            Err(ComprsError::SizeLimit {
                limit: 1_000_000,
                ..
            })
        ));
    }

    /// `len` zero bytes.
    fn zeros(len: usize) -> Vec<u8> {
        vec![0; len]
    }

    /// `len` bytes of xorshift noise, which does not compress.
    fn random(len: usize) -> Vec<u8> {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 32) as u8
            })
            .collect()
    }

    /// `len` bytes of JSON records, which compress well but not trivially.
    fn json(len: usize) -> Vec<u8> {
        let mut output = b"[".to_vec();
        for id in 0u64.. {
            if output.len() >= len {
                break;
            }
            let record = format!(
                r#"{{"id":{id},"name":"user {}","score":{},"active":{}}},"#,
                id * 7919 % 1000,
                id * 31 % 977,
                id % 3 == 0
            );
            output.extend_from_slice(record.as_bytes());
        }
        output.truncate(len);
        output
    }

    /// Compress `data` into one frame with the given settings.
    fn frame(data: &[u8], frame_info: FrameInfo) -> Vec<u8> {
        let mut encoder = lz4_flex::frame::FrameEncoder::with_frame_info(frame_info, Vec::new());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    /// Decompress `input` with an incremental context, in chunks of
    /// `chunk_size` bytes, then flush and finish it, checking after each
    /// call that the context keeps at most a block of the frame and its
    /// checksum. Returns the output.
    fn decompress_incrementally(
        input: &[u8],
        chunk_size: usize,
        block_size: usize,
    ) -> Result<Vec<u8>, ComprsError> {
        let mut ctx = DecompressContext::incremental(None).unwrap();
        let mut output = Vec::new();
        for chunk in input.chunks(chunk_size) {
            output.extend(ctx.transform(chunk)?);
            assert!(
                ctx.pending_capacity() <= block_size + 8,
                "keeps {} bytes of input",
                ctx.pending_capacity()
            );
        }
        assert!(ctx.flush()?.is_empty());
        output.extend(ctx.finish()?);
        Ok(output)
    }

    /// The block maximum size that `block_size` stands for.
    fn block_max(block_size: BlockSize) -> usize {
        match block_size {
            BlockSize::Max64KB => 64 * 1024,
            BlockSize::Max256KB => 256 * 1024,
            BlockSize::Max1MB => 1024 * 1024,
            BlockSize::Max4MB => 4 * 1024 * 1024,
            other => panic!("{other:?}"),
        }
    }

    /// Check that an incremental context fed `data` compressed into one
    /// frame with `frame_info`, in chunks of each of `chunk_sizes` bytes and
    /// all at once, decodes what one-shot decompression decodes. `name`
    /// describes the data.
    fn check_incremental(name: &str, data: &[u8], frame_info: FrameInfo, chunk_sizes: &[usize]) {
        let max = block_max(frame_info.block_size);
        let case = format!(
            "{name}, {max} B blocks, {:?}, checksums {}",
            frame_info.block_mode, frame_info.block_checksums
        );
        let input = frame(data, frame_info);
        assert!(crate::lz4::decompress(&input).unwrap() == data, "{case}");
        for &chunk_size in chunk_sizes.iter().chain([&input.len()]) {
            match decompress_incrementally(&input, chunk_size, max) {
                Ok(output) => assert!(
                    output == data,
                    "{case}, {chunk_size} B chunks: wrong output"
                ),
                Err(error) => panic!("{case}, {chunk_size} B chunks: {error}"),
            }
        }
    }

    /// Frame settings with every optional field, or none.
    fn frame_info(
        block_size: BlockSize,
        block_mode: BlockMode,
        fields: bool,
        len: usize,
    ) -> FrameInfo {
        FrameInfo::new()
            .block_size(block_size)
            .block_mode(block_mode)
            .block_checksums(fields)
            .content_checksum(fields)
            .content_size(fields.then_some(len as u64))
    }

    #[test]
    fn incremental_context_decodes_what_one_shot_decodes() {
        for (name, data) in [
            ("random", random(100_000)),
            ("json", json(200_000)),
            ("zeros", zeros(200_000)),
        ] {
            for block_size in [
                BlockSize::Max64KB,
                BlockSize::Max256KB,
                BlockSize::Max1MB,
                BlockSize::Max4MB,
            ] {
                for block_mode in [BlockMode::Independent, BlockMode::Linked] {
                    for fields in [false, true] {
                        let frame_info = frame_info(block_size, block_mode, fields, data.len());
                        check_incremental(name, &data, frame_info, &[1, 7, 64 * 1024]);
                    }
                }
            }
        }
    }

    #[test]
    fn incremental_context_links_large_blocks_across_chunks() {
        // Data of more than two blocks of 256 KiB and of 1 MiB, whose linked
        // blocks refer to the end of the block before, which the context
        // keeps from an earlier chunk or finds in the output of the same
        // one. Chunks of 1 byte would make the 2.2 MB slow to decode in a
        // debug build.
        for (block_size, data) in [
            (BlockSize::Max256KB, json(600_000)),
            (BlockSize::Max1MB, json(2_200_000)),
        ] {
            for fields in [false, true] {
                let frame_info = frame_info(block_size, BlockMode::Linked, fields, data.len());
                // The blocks do refer to the blocks before them.
                let mut unlinked = frame(&data, frame_info.clone());
                unlinked[4] |= 0x20;
                let descriptor_len = if fields { 10 } else { 2 };
                unlinked[4 + descriptor_len] =
                    (XxHash32::oneshot(0, &unlinked[4..4 + descriptor_len]) >> 8) as u8;
                assert_eq!(
                    crate::lz4::decompress(&unlinked).unwrap_err().to_string(),
                    "lz4 decompress failed: DecompressionError(OffsetOutOfBounds)"
                );
                check_incremental("json", &data, frame_info, &[7, 64 * 1024]);
            }
        }
    }

    #[test]
    fn incremental_context_links_small_blocks_across_chunks() {
        // Linked blocks of 1000 bytes, which the encoder writes when it is
        // flushed: a block refers to the content of the blocks before it,
        // in the output of the same chunk, of earlier chunks, or of both.
        let data = json(400_000);
        let mut encoder = lz4_flex::frame::FrameEncoder::with_frame_info(
            FrameInfo::new()
                .block_size(BlockSize::Max64KB)
                .block_mode(BlockMode::Linked)
                .content_checksum(true),
            Vec::new(),
        );
        for piece in data.chunks(1000) {
            encoder.write_all(piece).unwrap();
            encoder.flush().unwrap();
        }
        let input = encoder.finish().unwrap();
        assert_eq!(crate::lz4::decompress(&input).unwrap(), data);
        for chunk_size in [7, 2500, 100_000, input.len()] {
            match decompress_incrementally(&input, chunk_size, 64 * 1024) {
                Ok(output) => assert!(output == data, "{chunk_size} B chunks: wrong output"),
                Err(error) => panic!("{chunk_size} B chunks: {error}"),
            }
        }
    }

    /// A legacy frame of `blocks`, each compressed into one legacy block.
    fn legacy_frame(blocks: &[&[u8]]) -> (Vec<u8>, Vec<usize>) {
        let mut frame = crate::lz4::LEGACY_MAGIC.to_le_bytes().to_vec();
        let mut ends = vec![frame.len()];
        for block in blocks {
            let compressed = lz4_flex::block::compress(block);
            frame.extend((compressed.len() as u32).to_le_bytes());
            frame.extend(compressed);
            ends.push(frame.len());
        }
        (frame, ends)
    }

    #[test]
    fn incremental_context_ends_only_between_frames() {
        // Linked blocks of 500 bytes, with every checksum.
        let mut encoder = lz4_flex::frame::FrameEncoder::with_frame_info(
            FrameInfo::new()
                .block_size(BlockSize::Max64KB)
                .block_mode(BlockMode::Linked)
                .block_checksums(true)
                .content_checksum(true),
            Vec::new(),
        );
        for piece in json(1500).chunks(500) {
            encoder.write_all(piece).unwrap();
            encoder.flush().unwrap();
        }
        let lz4 = encoder.finish().unwrap();
        let skippable = [&0x184D_2A50_u32.to_le_bytes()[..], &[3, 0, 0, 0, 1, 2, 3]].concat();
        let (legacy, legacy_ends) = legacy_frame(&[&json(60), &random(30)]);
        let input = [&lz4[..], &skippable, &legacy].concat();
        // Where the input may end: after the LZ4 frame, after the skippable
        // frame, and at the block boundaries of the legacy frame, which has
        // no end mark, including right after its magic number.
        let legacy_start = lz4.len() + skippable.len();
        let mut ends = vec![lz4.len(), legacy_start];
        ends.extend(legacy_ends.iter().map(|end| legacy_start + end));

        for len in 0..=input.len() {
            let prefix = &input[..len];
            let one_shot = crate::lz4::decompress(prefix);
            for chunk_size in [7, input.len()] {
                let mut ctx = DecompressContext::incremental(None).unwrap();
                let mut output = Vec::new();
                for chunk in prefix.chunks(chunk_size) {
                    output.extend(ctx.transform(chunk).unwrap());
                }
                assert!(ctx.flush().unwrap().is_empty());
                match ctx.finish() {
                    Ok(rest) => {
                        assert!(ends.contains(&len), "ended at {len} bytes");
                        output.extend(rest);
                        assert_eq!(output, one_shot.as_deref().unwrap(), "{len} bytes");
                    }
                    Err(error) => {
                        assert!(!ends.contains(&len), "{len} bytes: {error}");
                        assert!(matches!(error, ComprsError::Truncated("lz4")), "{error}");
                        assert!(matches!(one_shot, Err(ComprsError::Truncated("lz4"))));
                    }
                }
            }
        }
    }

    #[test]
    fn incremental_context_rejects_data_after_a_frame_where_it_arrives() {
        let lz4 = crate::lz4::compress(b"complete").unwrap();
        let (legacy, _) = legacy_frame(&[b"complete legacy frame"]);
        // After a frame with an end, the first byte that cannot start a
        // magic number fails. After a legacy frame, the next 4 bytes are a
        // block size or a magic number: they fail once all have arrived.
        for (frame, bytes_to_fail) in [(lz4, 1), (legacy, 4)] {
            let mut ctx = DecompressContext::incremental(None).unwrap();
            let mut output = ctx.transform(&frame).unwrap();
            let trailing = b"garbage";
            for (index, byte) in trailing.iter().enumerate() {
                let result = ctx.transform(&[*byte]);
                if index + 1 < bytes_to_fail {
                    output.extend(result.unwrap());
                    continue;
                }
                assert_eq!(
                    result.unwrap_err().to_string(),
                    "lz4 stream decompress failed: unexpected data after the end of a frame"
                );
                break;
            }
            assert_eq!(output, crate::lz4::decompress(&frame).unwrap());
            // The context fails with the same error from then on.
            for result in [ctx.transform(b"more"), ctx.flush(), ctx.finish()] {
                assert_eq!(
                    result.unwrap_err().to_string(),
                    "lz4 stream decompress failed: unexpected data after the end of a frame"
                );
            }
            assert!(matches!(
                ctx.finish(),
                Err(ComprsError::StreamFinished("lz4 stream"))
            ));
        }
    }

    #[test]
    fn incremental_context_emits_blocks_as_they_arrive() {
        // 32 MiB in a frame of 256 KiB blocks, fed in 64 KiB chunks: each
        // block comes out with the chunk that completes it, and the context
        // keeps no more than one block of input.
        let data = json(32 * 1024 * 1024);
        let input = crate::lz4::compress(&data).unwrap();
        let mut ctx = DecompressContext::incremental(None).unwrap();
        let mut output = Vec::new();
        let chunks: Vec<&[u8]> = input.chunks(64 * 1024).collect();
        let (last, chunks) = chunks.split_last().unwrap();
        for chunk in chunks {
            output.extend(ctx.transform(chunk).unwrap());
            assert!(
                ctx.memory_usage() <= 256 * 1024 + 4,
                "{} bytes",
                ctx.memory_usage()
            );
        }
        // All but the blocks that end in the last chunk.
        assert!(
            output.len() >= data.len() - 1024 * 1024,
            "{} bytes before the last chunk",
            output.len()
        );
        output.extend(ctx.transform(last).unwrap());
        output.extend(ctx.finish().unwrap());
        assert!(output == data);
        assert_eq!(ctx.memory_usage(), 0);
    }

    #[test]
    fn incremental_context_time_does_not_grow_with_the_legacy_block_size() {
        // 20,000 legacy blocks of one literal each, one per transform():
        // a context that zero-fills a buffer of the 8 MiB that a legacy
        // block may decode to for each of them writes 160 GB here.
        let block = [&2u32.to_le_bytes()[..], &[0x10, b'a']].concat();
        let mut ctx = DecompressContext::incremental(None).unwrap();
        assert!(
            ctx.transform(&crate::lz4::LEGACY_MAGIC.to_le_bytes())
                .unwrap()
                .is_empty()
        );
        let start = std::time::Instant::now();
        for _ in 0..20_000 {
            assert_eq!(ctx.transform(&block).unwrap(), b"a");
        }
        // A fraction of the time that writing 160 GB takes on any machine.
        let elapsed = start.elapsed();
        assert!(elapsed.as_secs() < 2, "took {elapsed:?}");
        assert!(ctx.finish().unwrap().is_empty());
    }

    #[test]
    fn incremental_context_limits_the_whole_stream() {
        let frame = crate::lz4::compress(&vec![7; 800_000]).unwrap();
        let mut ctx = DecompressContext::incremental(Some(1_000_000.0)).unwrap();
        assert_eq!(ctx.transform(&frame).unwrap().len(), 800_000);
        assert!(matches!(
            ctx.transform(&frame),
            Err(ComprsError::SizeLimit {
                limit: 1_000_000,
                ..
            })
        ));
        assert!(matches!(ctx.flush(), Err(ComprsError::SizeLimit { .. })));
        assert!(matches!(ctx.finish(), Err(ComprsError::SizeLimit { .. })));

        let mut ctx = DecompressContext::incremental(Some(1_600_000.0)).unwrap();
        for _ in 0..2 {
            assert_eq!(ctx.transform(&frame).unwrap().len(), 800_000);
        }
        assert!(ctx.finish().unwrap().is_empty());
    }

    #[test]
    fn incremental_context_finish_ends_the_stream() {
        let compressed = crate::lz4::compress(b"lz4 stream").unwrap();
        let mut ctx = DecompressContext::incremental(None).unwrap();
        assert!(ctx.transform(&compressed[..10]).unwrap().is_empty());
        // flush() decodes nothing more, and does not fail for a partial
        // frame.
        assert!(ctx.flush().unwrap().is_empty());
        assert_eq!(ctx.transform(&compressed[10..]).unwrap(), b"lz4 stream");
        assert!(ctx.flush().unwrap().is_empty());
        assert!(ctx.finish().unwrap().is_empty());
        assert_eq!(ctx.memory_usage(), 0);
        for result in [ctx.transform(&compressed), ctx.flush(), ctx.finish()] {
            assert!(matches!(
                result,
                Err(ComprsError::StreamFinished("lz4 stream"))
            ));
        }

        // As in buffered mode, empty input is truncated.
        let mut ctx = DecompressContext::incremental(None).unwrap();
        assert!(ctx.transform(&[]).unwrap().is_empty());
        assert!(matches!(ctx.finish(), Err(ComprsError::Truncated("lz4"))));
        assert!(matches!(ctx.finish(), Err(ComprsError::StreamFinished(_))));
    }

    #[test]
    fn incremental_context_rejects_an_invalid_max_output_size() {
        assert!(matches!(
            DecompressContext::incremental(Some(-1.0)),
            Err(ComprsError::InvalidArg(_))
        ));
    }
}
