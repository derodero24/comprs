//! Brotli streaming compression and decompression.

use std::io::Write;

use crate::ComprsError;
use crate::brotli::{BUFFER_SIZE, DEFAULT_QUALITY, LG_WINDOW_SIZE};

/// Streaming brotli compression context.
pub struct CompressContext {
    compressor: Option<brotli::CompressorWriter<Vec<u8>>>,
}

impl CompressContext {
    pub fn new(quality: Option<u32>) -> Result<Self, ComprsError> {
        let quality = quality.unwrap_or(DEFAULT_QUALITY);
        if quality > 11 {
            return Err(ComprsError::InvalidArg(
                "brotli quality must be between 0 and 11".to_string(),
            ));
        }
        let compressor =
            brotli::CompressorWriter::new(Vec::new(), BUFFER_SIZE, quality, LG_WINDOW_SIZE);
        Ok(Self {
            compressor: Some(compressor),
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        let compressor = self
            .compressor
            .as_mut()
            .ok_or(ComprsError::StreamFinished("brotli stream"))?;

        compressor
            .write_all(chunk)
            .map_err(|e| ComprsError::Operation {
                context: "brotli stream compress",
                source: e.into(),
            })?;

        // Drain whatever the compressor has flushed to the inner Vec
        let data = std::mem::take(compressor.get_mut());
        Ok(data)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        let compressor = self
            .compressor
            .as_mut()
            .ok_or(ComprsError::StreamFinished("brotli stream"))?;

        compressor.flush().map_err(|e| ComprsError::Operation {
            context: "brotli stream flush",
            source: e.into(),
        })?;

        let data = std::mem::take(compressor.get_mut());
        Ok(data)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let compressor = self
            .compressor
            .take()
            .ok_or(ComprsError::StreamFinished("brotli stream"))?;

        // into_inner drops the CompressorWriter, which flushes remaining data
        // and writes the brotli stream end marker
        Ok(compressor.into_inner())
    }
}

/// Streaming brotli decompression context.
pub struct DecompressContext {
    decompressor: brotli::DecompressorWriter<Vec<u8>>,
    total_output: usize,
    max_output_size: usize,
}

impl DecompressContext {
    pub fn new(max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let decompressor = brotli::DecompressorWriter::new(Vec::new(), BUFFER_SIZE);
        Ok(Self {
            decompressor,
            total_output: 0,
            max_output_size: max_size,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.decompressor
            .write_all(chunk)
            .map_err(|e| ComprsError::Operation {
                context: "brotli stream decompress",
                source: e.into(),
            })?;

        // Drain whatever the decompressor has written to the inner Vec
        let data = std::mem::take(self.decompressor.get_mut());
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ComprsError::SizeLimit {
                context: "brotli stream decompress",
                limit: self.max_output_size,
            });
        }
        Ok(data)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.decompressor
            .flush()
            .map_err(|e| ComprsError::Operation {
                context: "brotli stream flush",
                source: e.into(),
            })?;

        let data = std::mem::take(self.decompressor.get_mut());
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ComprsError::SizeLimit {
                context: "brotli stream decompress",
                limit: self.max_output_size,
            });
        }
        Ok(data)
    }
}

/// Streaming brotli compression context with custom dictionary.
///
/// Buffers all input and compresses with the dictionary on `finish`.
/// This is necessary because the brotli CompressorWriter does not expose
/// a dictionary API; dictionary compression requires the low-level encoder.
pub struct CompressDictContext {
    dict: Option<Vec<u8>>,
    quality: u32,
    chunks: Vec<u8>,
}

impl CompressDictContext {
    pub fn new(dict: &[u8], quality: Option<u32>) -> Result<Self, ComprsError> {
        let quality = quality.unwrap_or(DEFAULT_QUALITY);
        if quality > 11 {
            return Err(ComprsError::InvalidArg(
                "brotli quality must be between 0 and 11".to_string(),
            ));
        }
        Ok(Self {
            dict: Some(dict.to_vec()),
            quality,
            chunks: Vec::new(),
        })
    }

    /// Buffer a chunk of data for compression. Returns an empty Vec because
    /// all compression is deferred to `finish` (dictionary requires one-shot).
    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        if self.dict.is_none() {
            return Err(ComprsError::StreamFinished("brotli dict stream"));
        }
        self.chunks.extend_from_slice(chunk);
        Ok(Vec::new())
    }

    /// Flush returns empty Vec because all data is buffered until finish.
    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        if self.dict.is_none() {
            return Err(ComprsError::StreamFinished("brotli dict stream"));
        }
        Ok(Vec::new())
    }

    /// Finalize the compression. Compresses all buffered data with the dictionary.
    pub fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
        let dict = self
            .dict
            .take()
            .ok_or(ComprsError::StreamFinished("brotli dict stream"))?;

        let data = std::mem::take(&mut self.chunks);
        crate::brotli::compress_with_dict_inner(&data, &dict, self.quality).map_err(|e| {
            ComprsError::Operation {
                context: "brotli dict stream compress",
                source: e.into(),
            }
        })
    }
}

/// Streaming brotli decompression context with custom dictionary.
pub struct DecompressDictContext {
    decompressor: brotli::DecompressorWriter<Vec<u8>>,
    total_output: usize,
    max_output_size: usize,
}

impl DecompressDictContext {
    pub fn new(dict: &[u8], max_output_size: Option<f64>) -> Result<Self, ComprsError> {
        let max_size = crate::validate_max_output_size(max_output_size)?;
        let dict_bytes = dict.to_vec();
        let decompressor = brotli::DecompressorWriter::new_with_custom_dictionary(
            Vec::new(),
            BUFFER_SIZE,
            dict_bytes.into(),
        );
        Ok(Self {
            decompressor,
            total_output: 0,
            max_output_size: max_size,
        })
    }

    pub fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.decompressor
            .write_all(chunk)
            .map_err(|e| ComprsError::Operation {
                context: "brotli dict stream decompress",
                source: e.into(),
            })?;

        let data = std::mem::take(self.decompressor.get_mut());
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ComprsError::SizeLimit {
                context: "brotli dict stream decompress",
                limit: self.max_output_size,
            });
        }
        Ok(data)
    }

    pub fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.decompressor
            .flush()
            .map_err(|e| ComprsError::Operation {
                context: "brotli dict stream flush",
                source: e.into(),
            })?;

        let data = std::mem::take(self.decompressor.get_mut());
        self.total_output += data.len();
        if self.total_output > self.max_output_size {
            return Err(ComprsError::SizeLimit {
                context: "brotli dict stream decompress",
                limit: self.max_output_size,
            });
        }
        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use crate::brotli::{BUFFER_SIZE, DEFAULT_QUALITY, LG_WINDOW_SIZE};

    #[test]
    fn stream_round_trip() {
        let original = b"Hello, comprs streaming! ".repeat(100);

        // Compress in chunks using CompressorWriter<Vec<u8>>
        let mut compressor =
            brotli::CompressorWriter::new(Vec::new(), BUFFER_SIZE, DEFAULT_QUALITY, LG_WINDOW_SIZE);
        for chunk in original.chunks(256) {
            compressor.write_all(chunk).unwrap();
        }
        let compressed = compressor.into_inner();

        // Decompress using Decompressor
        let mut decompressor = brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE);
        let mut decompressed = Vec::new();
        decompressor.read_to_end(&mut decompressed).unwrap();

        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn stream_empty_input() {
        let compressor =
            brotli::CompressorWriter::new(Vec::new(), BUFFER_SIZE, DEFAULT_QUALITY, LG_WINDOW_SIZE);
        let compressed = compressor.into_inner();

        // Should produce a valid (empty) brotli stream
        assert!(!compressed.is_empty());

        let mut decompressor = brotli::Decompressor::new(compressed.as_slice(), BUFFER_SIZE);
        let mut decompressed = Vec::new();
        decompressor.read_to_end(&mut decompressed).unwrap();
        assert!(decompressed.is_empty());
    }

    #[test]
    fn stream_decompressor_writer_round_trip() {
        let original = b"DecompressorWriter test data ".repeat(100);

        // Compress
        let mut compressor =
            brotli::CompressorWriter::new(Vec::new(), BUFFER_SIZE, DEFAULT_QUALITY, LG_WINDOW_SIZE);
        compressor.write_all(&original).unwrap();
        let compressed = compressor.into_inner();

        // Decompress in chunks using DecompressorWriter<Vec<u8>>
        let mut decompressor = brotli::DecompressorWriter::new(Vec::new(), BUFFER_SIZE);
        for chunk in compressed.chunks(64) {
            decompressor.write_all(chunk).unwrap();
        }
        decompressor.flush().unwrap();
        let decompressed = decompressor.into_inner().unwrap();

        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
