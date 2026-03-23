//! Zstandard streaming compression and decompression.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use zstd::stream::raw::{Decoder, Encoder, InBuffer, Operation, OutBuffer};

use crate::ZflateError;

/// Default compression level for zstd (same as the C library default).
const DEFAULT_LEVEL: i32 = 3;

/// Initial output buffer size for streaming operations.
const INITIAL_BUF_SIZE: usize = 128 * 1024;

/// Streaming zstd compression context.
///
/// Maintains internal compression state across multiple `transform` calls,
/// enabling chunked compression without losing cross-chunk context.
#[napi]
pub struct ZstdCompressContext {
    encoder: Option<Encoder<'static>>,
}

#[napi]
impl ZstdCompressContext {
    #[napi(constructor)]
    pub fn new(level: Option<i32>) -> Result<Self> {
        let level = level.unwrap_or(DEFAULT_LEVEL);
        if !(-131072..=22).contains(&level) {
            return Err(ZflateError::InvalidArg(
                "zstd compression level must be between -131072 and 22".to_string(),
            )
            .into());
        }
        let encoder = Encoder::new(level).map_err(|e| {
            napi::Error::from(ZflateError::Creation {
                context: "zstd encoder",
                source: e.into(),
            })
        })?;
        Ok(Self {
            encoder: Some(encoder),
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the encoder is buffering data internally).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("zstd stream")))?;

        let input = crate::as_bytes(&chunk);
        let bound = zstd::zstd_safe::compress_bound(input.len());
        let mut output = vec![0u8; bound.max(INITIAL_BUF_SIZE)];

        let mut in_buf = InBuffer::around(input);
        let mut total_written = 0;

        while in_buf.pos() < in_buf.src.len() {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            encoder.run(&mut in_buf, &mut out_buf).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "zstd stream compress",
                    source: e.into(),
                })
            })?;
            total_written = out_buf.pos();
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output.into())
    }

    /// Flush the encoder's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("zstd stream")))?;

        let mut output = vec![0u8; INITIAL_BUF_SIZE];
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            let remaining = encoder.flush(&mut out_buf).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "zstd stream flush",
                    source: e.into(),
                })
            })?;
            total_written = out_buf.pos();
            if remaining == 0 {
                break;
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output.into())
    }

    /// Finalize the compression stream. Writes the zstd frame footer.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        let mut encoder = self
            .encoder
            .take()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("zstd stream")))?;

        let mut output = vec![0u8; INITIAL_BUF_SIZE];
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            let remaining = encoder.finish(&mut out_buf, true).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "zstd stream finish",
                    source: e.into(),
                })
            })?;
            total_written = out_buf.pos();
            if remaining == 0 {
                break;
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output.into())
    }
}

/// Streaming zstd decompression context.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// enabling chunked decompression of a zstd frame.
#[napi]
pub struct ZstdDecompressContext {
    decoder: Decoder<'static>,
    total_output: usize,
    max_output_size: usize,
}

#[napi]
impl ZstdDecompressContext {
    #[napi(constructor)]
    pub fn new(max_output_size: Option<f64>) -> Result<Self> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decoder = Decoder::new().map_err(|e| {
            napi::Error::from(ZflateError::Creation {
                context: "zstd decoder",
                source: e.into(),
            })
        })?;
        Ok(Self {
            decoder,
            total_output: 0,
            max_output_size: max_size,
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decoder needs more data).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        let input = crate::as_bytes(&chunk);
        // Decompressed output can be much larger than input
        let mut output = vec![0u8; input.len().max(INITIAL_BUF_SIZE)];

        let mut in_buf = InBuffer::around(input);
        let mut total_written = 0;

        while in_buf.pos() < in_buf.src.len() {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            self.decoder.run(&mut in_buf, &mut out_buf).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "zstd stream decompress",
                    source: e.into(),
                })
            })?;
            total_written = out_buf.pos();
            if self.total_output + total_written > self.max_output_size {
                return Err(ZflateError::SizeLimit {
                    context: "zstd stream decompress",
                    limit: self.max_output_size,
                }
                .into());
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        self.total_output += total_written;
        output.truncate(total_written);
        Ok(output.into())
    }

    /// Flush the decoder's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        let mut output = vec![0u8; INITIAL_BUF_SIZE];
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            let remaining = self.decoder.flush(&mut out_buf).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "zstd stream flush",
                    source: e.into(),
                })
            })?;
            total_written = out_buf.pos();
            if remaining == 0 {
                break;
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output.into())
    }
}

/// Streaming zstd compression context with dictionary.
///
/// Maintains internal compression state across multiple `transform` calls,
/// using a pre-trained dictionary for improved compression of small, similar data.
#[napi]
pub struct ZstdCompressDictContext {
    encoder: Option<Encoder<'static>>,
}

#[napi]
impl ZstdCompressDictContext {
    #[napi(constructor)]
    pub fn new(dict: Either<Buffer, Uint8Array>, level: Option<i32>) -> Result<Self> {
        let level = level.unwrap_or(DEFAULT_LEVEL);
        if !(-131072..=22).contains(&level) {
            return Err(ZflateError::InvalidArg(
                "zstd compression level must be between -131072 and 22".to_string(),
            )
            .into());
        }
        let dict_bytes = crate::as_bytes(&dict);
        let encoder = Encoder::with_dictionary(level, dict_bytes).map_err(|e| {
            napi::Error::from(ZflateError::Creation {
                context: "zstd dict encoder",
                source: e.into(),
            })
        })?;
        Ok(Self {
            encoder: Some(encoder),
        })
    }

    /// Compress a chunk of data. Returns compressed output (may be empty if
    /// the encoder is buffering data internally).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("zstd stream")))?;

        let input = crate::as_bytes(&chunk);
        let bound = zstd::zstd_safe::compress_bound(input.len());
        let mut output = vec![0u8; bound.max(INITIAL_BUF_SIZE)];

        let mut in_buf = InBuffer::around(input);
        let mut total_written = 0;

        while in_buf.pos() < in_buf.src.len() {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            encoder.run(&mut in_buf, &mut out_buf).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "zstd stream compress",
                    source: e.into(),
                })
            })?;
            total_written = out_buf.pos();
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output.into())
    }

    /// Flush the encoder's internal buffer. Returns any buffered compressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("zstd stream")))?;

        let mut output = vec![0u8; INITIAL_BUF_SIZE];
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            let remaining = encoder.flush(&mut out_buf).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "zstd stream flush",
                    source: e.into(),
                })
            })?;
            total_written = out_buf.pos();
            if remaining == 0 {
                break;
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output.into())
    }

    /// Finalize the compression stream. Writes the zstd frame footer.
    /// Must be called once after all data has been transformed.
    #[napi]
    pub fn finish(&mut self) -> Result<Buffer> {
        let mut encoder = self
            .encoder
            .take()
            .ok_or_else(|| napi::Error::from(ZflateError::StreamFinished("zstd stream")))?;

        let mut output = vec![0u8; INITIAL_BUF_SIZE];
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            let remaining = encoder.finish(&mut out_buf, true).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "zstd stream finish",
                    source: e.into(),
                })
            })?;
            total_written = out_buf.pos();
            if remaining == 0 {
                break;
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output.into())
    }
}

/// Streaming zstd decompression context with dictionary.
///
/// Maintains internal decompression state across multiple `transform` calls,
/// using a pre-trained dictionary that matches the one used for compression.
#[napi]
pub struct ZstdDecompressDictContext {
    decoder: Decoder<'static>,
    total_output: usize,
    max_output_size: usize,
}

#[napi]
impl ZstdDecompressDictContext {
    #[napi(constructor)]
    pub fn new(dict: Either<Buffer, Uint8Array>, max_output_size: Option<f64>) -> Result<Self> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let dict_bytes = crate::as_bytes(&dict);
        let decoder = Decoder::with_dictionary(dict_bytes).map_err(|e| {
            napi::Error::from(ZflateError::Creation {
                context: "zstd dict decoder",
                source: e.into(),
            })
        })?;
        Ok(Self {
            decoder,
            total_output: 0,
            max_output_size: max_size,
        })
    }

    /// Decompress a chunk of compressed data. Returns decompressed output
    /// (may be empty if the decoder needs more data).
    #[napi]
    pub fn transform(&mut self, chunk: Either<Buffer, Uint8Array>) -> Result<Buffer> {
        let input = crate::as_bytes(&chunk);
        // Decompressed output can be much larger than input
        let mut output = vec![0u8; input.len().max(INITIAL_BUF_SIZE)];

        let mut in_buf = InBuffer::around(input);
        let mut total_written = 0;

        while in_buf.pos() < in_buf.src.len() {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            self.decoder.run(&mut in_buf, &mut out_buf).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "zstd stream decompress",
                    source: e.into(),
                })
            })?;
            total_written = out_buf.pos();
            if self.total_output + total_written > self.max_output_size {
                return Err(ZflateError::SizeLimit {
                    context: "zstd stream decompress",
                    limit: self.max_output_size,
                }
                .into());
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        self.total_output += total_written;
        output.truncate(total_written);
        Ok(output.into())
    }

    /// Flush the decoder's internal buffer. Returns any buffered decompressed data.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        let mut output = vec![0u8; INITIAL_BUF_SIZE];
        let mut total_written = 0;

        loop {
            let mut out_buf = OutBuffer::around_pos(&mut output, total_written);
            let remaining = self.decoder.flush(&mut out_buf).map_err(|e| {
                napi::Error::from(ZflateError::Operation {
                    context: "zstd stream flush",
                    source: e.into(),
                })
            })?;
            total_written = out_buf.pos();
            if remaining == 0 {
                break;
            }
            if total_written >= output.len() {
                output.resize(output.len() * 2, 0);
            }
        }

        output.truncate(total_written);
        Ok(output.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_round_trip() {
        let original = b"Hello, comprs streaming! ".repeat(100);

        // Compress in chunks
        let mut encoder = Encoder::new(DEFAULT_LEVEL).unwrap();
        let mut compressed = Vec::new();

        for chunk in original.chunks(256) {
            let mut in_buf = InBuffer::around(chunk);
            while in_buf.pos() < in_buf.src.len() {
                let mut out = vec![0u8; 1024];
                let mut out_buf = OutBuffer::around(&mut out);
                encoder.run(&mut in_buf, &mut out_buf).unwrap();
                let written = out_buf.pos();
                compressed.extend_from_slice(&out[..written]);
            }
        }

        // Finish the frame
        loop {
            let mut out = vec![0u8; 1024];
            let mut out_buf = OutBuffer::around(&mut out);
            let remaining = encoder.finish(&mut out_buf, true).unwrap();
            let written = out_buf.pos();
            compressed.extend_from_slice(&out[..written]);
            if remaining == 0 {
                break;
            }
        }

        // Decompress in chunks
        let mut decoder = Decoder::new().unwrap();
        let mut decompressed = Vec::new();

        for chunk in compressed.chunks(64) {
            let mut in_buf = InBuffer::around(chunk);
            while in_buf.pos() < in_buf.src.len() {
                let mut out = vec![0u8; 1024];
                let mut out_buf = OutBuffer::around(&mut out);
                decoder.run(&mut in_buf, &mut out_buf).unwrap();
                let written = out_buf.pos();
                decompressed.extend_from_slice(&out[..written]);
            }
        }

        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn stream_empty_input() {
        let mut encoder = Encoder::new(DEFAULT_LEVEL).unwrap();

        // Finish immediately (empty frame)
        let mut compressed = Vec::new();
        loop {
            let mut out = vec![0u8; 1024];
            let mut out_buf = OutBuffer::around(&mut out);
            let remaining = encoder.finish(&mut out_buf, true).unwrap();
            let written = out_buf.pos();
            compressed.extend_from_slice(&out[..written]);
            if remaining == 0 {
                break;
            }
        }

        // Should produce a valid (empty) zstd frame
        assert!(!compressed.is_empty());

        let decompressed = zstd::bulk::decompress(&compressed, 1024).unwrap();
        assert!(decompressed.is_empty());
    }
}
