//! Helpers shared by the integration tests, which reach only the public API
//! of comprs-core.

// Each test binary uses a different subset of the helpers.
#![allow(dead_code)]

use comprs_core::{ComprsError, MemoryUsage, brotli_stream, gzip_stream, lz4_stream, zstd_stream};

/// The methods that every stream context has, so that tests can drive any
/// of them.
pub trait Context: MemoryUsage {
    fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError>;
    fn flush(&mut self) -> Result<Vec<u8>, ComprsError>;
    fn finish(&mut self) -> Result<Vec<u8>, ComprsError>;
}

macro_rules! impl_context {
    ($($context:ty),* $(,)?) => {$(
        impl Context for $context {
            fn transform(&mut self, chunk: &[u8]) -> Result<Vec<u8>, ComprsError> {
                <$context>::transform(self, chunk)
            }

            fn flush(&mut self) -> Result<Vec<u8>, ComprsError> {
                <$context>::flush(self)
            }

            fn finish(&mut self) -> Result<Vec<u8>, ComprsError> {
                <$context>::finish(self)
            }
        }
    )*};
}

impl_context!(
    gzip_stream::GzipCompressContext,
    gzip_stream::GzipDecompressContext,
    gzip_stream::DeflateCompressContext,
    gzip_stream::DeflateDecompressContext,
    gzip_stream::ZlibCompressContext,
    gzip_stream::StrictDecompressContext,
    brotli_stream::CompressContext,
    brotli_stream::DecompressContext,
    brotli_stream::CompressDictContext,
    brotli_stream::DecompressDictContext,
    zstd_stream::CompressContext,
    zstd_stream::DecompressContext,
    zstd_stream::CompressDictContext,
    zstd_stream::DecompressDictContext,
    lz4_stream::CompressContext,
    lz4_stream::DecompressContext,
);

/// A context of any type.
pub type BoxedContext = Box<dyn Context>;

/// Box a newly created context.
pub fn boxed<C: Context + 'static>(
    ctx: Result<C, ComprsError>,
) -> Result<BoxedContext, ComprsError> {
    Ok(Box::new(ctx?))
}

/// Feed `input` to `ctx` in chunks whose sizes cycle through `chunk_sizes`,
/// then flush and finish it, and return all the output.
pub fn drive(
    ctx: &mut dyn Context,
    input: &[u8],
    chunk_sizes: &[usize],
) -> Result<Vec<u8>, ComprsError> {
    assert!(
        !chunk_sizes.is_empty() && !chunk_sizes.contains(&0),
        "chunk sizes {chunk_sizes:?}"
    );
    let mut output = Vec::new();
    let mut rest = input;
    for &size in chunk_sizes.iter().cycle() {
        if rest.is_empty() {
            break;
        }
        let (chunk, tail) = rest.split_at(size.min(rest.len()));
        output.extend(ctx.transform(chunk)?);
        rest = tail;
    }
    output.extend(ctx.flush()?);
    output.extend(ctx.finish()?);
    Ok(output)
}

/// `len` bytes of text-like data, which every format compresses well but
/// not trivially.
pub fn text(len: usize) -> Vec<u8> {
    const WORDS: [&[u8]; 8] = [
        b"stream ", b"chunk ", b"frame ", b"block ", b"window ", b"level ", b"output ", b"\n",
    ];
    let mut output = Vec::with_capacity(len + 8);
    for byte in noise(len, 1) {
        if output.len() >= len {
            break;
        }
        output.extend_from_slice(WORDS[usize::from(byte % 8)]);
    }
    output.truncate(len);
    output
}

/// `len` bytes of xorshift noise, which no format compresses. Different
/// seeds give different bytes.
pub fn noise(len: usize, seed: u64) -> Vec<u8> {
    let mut state = 0x9e37_79b9_7f4a_7c15 ^ seed.wrapping_mul(0x2545_f491_4f6c_dd1d);
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 32) as u8
        })
        .collect()
}
