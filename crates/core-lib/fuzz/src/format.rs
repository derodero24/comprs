//! One interface over the per-format APIs of comprs-core.

use comprs_core::dictionary::{Dictionary, DictionaryFormat};
use comprs_core::{
    ComprsError, brotli, brotli_stream, gzip, gzip_stream, lz4, lz4_stream, unified, zstd,
    zstd_stream,
};

/// The magic number 0xEC30A437 that starts a formatted zstd dictionary, in
/// the byte order of the dictionary.
const ZSTD_DICT_MAGIC: [u8; 4] = 0xEC30_A437_u32.to_le_bytes();

/// A compression format, with the comprs-core functions that handle it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Zstd,
    Gzip,
    Deflate,
    Brotli,
    Lz4,
}

impl Format {
    pub const ALL: [Format; 5] = [
        Format::Zstd,
        Format::Gzip,
        Format::Deflate,
        Format::Brotli,
        Format::Lz4,
    ];

    /// Whether the format has dictionary APIs.
    pub fn has_dict(self) -> bool {
        matches!(self, Format::Zstd | Format::Brotli)
    }

    /// Whether compression may reject `dict`. zstd reads a dictionary that
    /// starts with its magic number as a formatted dictionary, whose entropy
    /// tables fuzzer-chosen bytes rarely get right. Any other bytes make a
    /// raw-content dictionary, which every format accepts.
    pub fn may_reject_dict(self, dict: Option<&[u8]>) -> bool {
        self == Format::Zstd && dict.is_some_and(|dict| dict.starts_with(&ZSTD_DICT_MAGIC))
    }

    /// `dict` prepared as a zstd [`Dictionary`], for the zstd functions that
    /// take one. `None` for the other formats, whose prepared dictionaries
    /// only hold the bytes, for no or an empty dictionary, which
    /// [`Dictionary::new`] rejects, and for a dictionary that zstd rejects
    /// ([`Format::may_reject_dict`]).
    pub fn prepare(self, dict: Option<&[u8]>) -> Option<Dictionary> {
        let dict = dict.filter(|dict| self == Format::Zstd && !dict.is_empty())?;
        match Dictionary::new(dict, DictionaryFormat::Zstd, None) {
            Ok(prepared) => Some(prepared),
            Err(_) if self.may_reject_dict(Some(dict)) => None,
            Err(error) => panic!("zstd dictionary preparation failed: {error}"),
        }
    }

    /// Heap memory that a decoder may use besides its input and output, for
    /// the checks against [`crate::heap::measure`].
    pub fn decoder_overhead(self) -> usize {
        const KIB: usize = 1024;
        const MIB: usize = 1024 * KIB;
        match self {
            // The decoder state lives in the C library, which is not counted.
            Format::Zstd => 64 * KIB,
            // zlib-rs: the inflate state and a 32 KiB window; flate2's gzip
            // decoders add a 32 KiB buffer.
            Format::Gzip | Format::Deflate => 256 * KIB,
            // A ring buffer as large as the window, plus Huffman tables and
            // context maps. RFC 7932 caps the window at 16 MiB; the 1 GiB
            // windows of the Large Window Brotli extension exceed the bound.
            Format::Brotli => 18 * MIB,
            // The decoder decodes each block into a buffer of up to the
            // block maximum size, 8 MiB for a legacy frame. In incremental
            // mode, the context also keeps a block that has not fully
            // arrived, up to the 8 MiB of a legacy block, and 128 KiB of the
            // content of linked blocks.
            Format::Lz4 => 17 * MIB,
        }
    }

    /// Decompress `data` in one call into at most `limit` bytes.
    ///
    /// `dict` selects the dictionary variant and is ignored by formats
    /// without one.
    pub fn decompress(
        self,
        data: &[u8],
        dict: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<u8>, ComprsError> {
        match (self, dict) {
            (Format::Zstd, None) => zstd::decompress_with_capacity(data, limit),
            (Format::Zstd, Some(dict)) => {
                zstd::decompress_with_dict_with_capacity(data, dict, limit)
            }
            (Format::Gzip, _) => gzip::decompress_with_capacity(data, limit),
            (Format::Deflate, _) => gzip::deflate_decompress_with_capacity(data, limit),
            (Format::Brotli, None) => brotli::decompress_with_capacity(data, limit),
            (Format::Brotli, Some(dict)) => {
                brotli::decompress_with_dict_with_capacity(data, dict, limit)
            }
            (Format::Lz4, _) => lz4::decompress_with_capacity(data, limit),
        }
    }

    /// Decompress `data` in one call with the default output limit,
    /// [`comprs_core::MAX_DECOMPRESSED_SIZE`].
    pub fn decompress_unlimited(
        self,
        data: &[u8],
        dict: Option<&[u8]>,
    ) -> Result<Vec<u8>, ComprsError> {
        match (self, dict) {
            (Format::Zstd, None) => zstd::decompress(data),
            (Format::Zstd, Some(dict)) => zstd::decompress_with_dict(data, dict),
            (Format::Gzip, _) => gzip::decompress(data),
            (Format::Deflate, _) => gzip::deflate_decompress(data),
            (Format::Brotli, None) => brotli::decompress(data),
            (Format::Brotli, Some(dict)) => brotli::decompress_with_dict(data, dict),
            (Format::Lz4, _) => lz4::decompress(data),
        }
    }

    /// Create a streaming decompression context. `incremental` selects the
    /// incremental mode of the LZ4 context; the other formats ignore it.
    pub fn decompressor(
        self,
        dict: Option<&[u8]>,
        max_output_size: Option<f64>,
        incremental: bool,
    ) -> Result<Box<dyn Stream>, ComprsError> {
        Ok(match (self, dict) {
            (Format::Zstd, None) => Box::new(zstd_stream::DecompressContext::new(max_output_size)?),
            (Format::Zstd, Some(dict)) => Box::new(zstd_stream::DecompressDictContext::new(
                dict,
                max_output_size,
            )?),
            (Format::Gzip, _) => {
                Box::new(gzip_stream::GzipDecompressContext::new(max_output_size)?)
            }
            (Format::Deflate, _) => {
                Box::new(gzip_stream::DeflateDecompressContext::new(max_output_size)?)
            }
            (Format::Brotli, None) => {
                Box::new(brotli_stream::DecompressContext::new(max_output_size)?)
            }
            (Format::Brotli, Some(dict)) => Box::new(brotli_stream::DecompressDictContext::new(
                dict,
                max_output_size,
            )?),
            (Format::Lz4, _) if incremental => Box::new(Lz4Incremental(
                lz4_stream::DecompressContext::incremental(max_output_size)?,
            )),
            (Format::Lz4, _) => Box::new(lz4_stream::DecompressContext::new(max_output_size)?),
        })
    }

    /// Compress `data` in one call. `level` is the zstd level, the
    /// gzip/deflate level or the brotli quality, and LZ4 ignores it.
    pub fn compress(
        self,
        data: &[u8],
        dict: Option<&[u8]>,
        level: Option<i32>,
    ) -> Result<Vec<u8>, ComprsError> {
        match (self, dict) {
            (Format::Zstd, None) => zstd::compress(data, level),
            (Format::Zstd, Some(dict)) => zstd::compress_with_dict(data, dict, level),
            (Format::Gzip, _) => gzip::compress(data, unsigned(level)),
            (Format::Deflate, _) => gzip::deflate_compress(data, unsigned(level)),
            (Format::Brotli, None) => brotli::compress(data, unsigned(level)),
            (Format::Brotli, Some(dict)) => brotli::compress_with_dict(data, dict, unsigned(level)),
            (Format::Lz4, _) => lz4::compress(data),
        }
    }

    /// Create a streaming compression context, with `level` as in
    /// [`Format::compress`]. `incremental` selects the incremental mode of
    /// the brotli dictionary context; the other contexts ignore it.
    pub fn compressor(
        self,
        dict: Option<&[u8]>,
        level: Option<i32>,
        incremental: bool,
    ) -> Result<Box<dyn Stream>, ComprsError> {
        Ok(match (self, dict) {
            (Format::Zstd, None) => Box::new(zstd_stream::CompressContext::new(level)?),
            (Format::Zstd, Some(dict)) => {
                Box::new(zstd_stream::CompressDictContext::new(dict, level)?)
            }
            (Format::Gzip, _) => Box::new(gzip_stream::GzipCompressContext::new(unsigned(level))?),
            (Format::Deflate, _) => {
                Box::new(gzip_stream::DeflateCompressContext::new(unsigned(level))?)
            }
            (Format::Brotli, None) => {
                Box::new(brotli_stream::CompressContext::new(unsigned(level))?)
            }
            (Format::Brotli, Some(dict)) if incremental => Box::new(
                brotli_stream::CompressDictContext::incremental(dict, unsigned(level))?,
            ),
            (Format::Brotli, Some(dict)) => Box::new(brotli_stream::CompressDictContext::new(
                dict,
                unsigned(level),
            )?),
            (Format::Lz4, _) => Box::new(lz4_stream::CompressContext::new()),
        })
    }
}

/// The gzip, deflate and brotli APIs take unsigned levels. Negative levels
/// become out-of-range ones, which those APIs reject.
pub(crate) fn unsigned(level: Option<i32>) -> Option<u32> {
    level.map(|level| u32::try_from(level).unwrap_or(u32::MAX))
}

/// The methods that every comprs-core stream context has.
pub trait Stream {
    fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError>;
    fn flush(&mut self) -> Result<Vec<u8>, ComprsError>;
    /// `None` for a context without `finish`: the buffered LZ4 decompression
    /// context, whose `flush` decodes the buffered input.
    fn finish(&mut self) -> Option<Result<Vec<u8>, ComprsError>>;
}

macro_rules! impl_stream {
    ($($context:ty),+ $(,)?) => {$(
        impl Stream for $context {
            fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
                <$context>::transform(self, chunk)
            }

            fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
                <$context>::flush(self)
            }

            fn finish(&mut self) -> Option<Result<Vec<u8>, ComprsError>> {
                Some(<$context>::finish(self))
            }
        }
    )+};
}

impl_stream!(
    zstd_stream::CompressContext,
    zstd_stream::CompressDictContext,
    zstd_stream::DecompressContext,
    zstd_stream::DecompressDictContext,
    gzip_stream::GzipCompressContext,
    gzip_stream::GzipDecompressContext,
    gzip_stream::DeflateCompressContext,
    gzip_stream::DeflateDecompressContext,
    brotli_stream::CompressContext,
    brotli_stream::CompressDictContext,
    brotli_stream::DecompressContext,
    brotli_stream::DecompressDictContext,
    lz4_stream::CompressContext,
    unified::DecompressContext,
);

impl Stream for lz4_stream::DecompressContext {
    fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        lz4_stream::DecompressContext::transform(self, chunk)
    }

    fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        lz4_stream::DecompressContext::flush(self)
    }

    fn finish(&mut self) -> Option<Result<Vec<u8>, ComprsError>> {
        None
    }
}

/// An LZ4 decompression context in incremental mode, whose `finish`, unlike
/// that of the buffered context, checks that the input ended between frames.
pub struct Lz4Incremental(lz4_stream::DecompressContext);

impl Stream for Lz4Incremental {
    fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
        self.0.transform(chunk)
    }

    fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
        self.0.flush()
    }

    fn finish(&mut self) -> Option<Result<Vec<u8>, ComprsError>> {
        Some(self.0.finish())
    }
}
