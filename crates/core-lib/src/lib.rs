#![deny(clippy::all)]

mod args;
pub mod brotli;
pub mod brotli_stream;
pub mod crc;
pub mod detect;
pub mod error;
pub mod gzip;
pub mod gzip_stream;
mod limited;
pub mod lz4;
pub mod lz4_stream;
pub mod zstd;
pub mod zstd_stream;

pub use args::{IntArg, validate_capacity, validate_max_output_size};
pub use error::{ComprsError, ERROR_CODES};

/// Maximum allowed decompressed size (256 MB) to prevent memory exhaustion.
pub const MAX_DECOMPRESSED_SIZE: usize = 256 * 1024 * 1024;

/// Heap memory held by a stream context, so that bindings can report it to
/// their runtime: a JavaScript engine sees only a small wrapper object and
/// does not otherwise know that collecting it frees megabytes.
pub trait MemoryUsage {
    /// Number of bytes of heap memory the context holds: its codec state and
    /// its buffers.
    ///
    /// zstd and brotli contexts measure their state; gzip, deflate and lz4
    /// contexts use the fixed size of theirs. The figure changes as the
    /// stream progresses: zstd and brotli allocate most of their state once
    /// data arrives, decoders size their window from the stream, and
    /// contexts that buffer input grow with it.
    fn memory_usage(&self) -> usize;
}

/// Release the spare capacity of a one-shot function's result if it is
/// large.
///
/// Encoders reserve output space from the input size and decoders grow their
/// output geometrically, so a result can hold far more memory than its
/// length: 19 bytes of brotli output kept an 8 MB buffer. The bindings hand
/// the whole allocation to the JavaScript engine, which sees only the length
/// and frees the allocation only with the object, so the spare capacity
/// would live as long as the result. Up to an eighth of the length, or
/// 4 KiB, is kept rather than reallocated.
pub(crate) fn finish_output(mut output: Vec<u8>) -> Vec<u8> {
    if output.capacity() - output.len() > (output.len() / 8).max(4096) {
        output.shrink_to_fit();
    }
    output
}

/// Reject empty input to a decompressor: no supported format has a valid
/// zero-length encoding, so empty input is treated as truncated.
pub(crate) fn require_input(data: &[u8], format: &'static str) -> Result<(), ComprsError> {
    if data.is_empty() {
        return Err(ComprsError::Truncated(format));
    }
    Ok(())
}

/// Decompress data from a reader with a size limit.
///
/// Uses `Read::read_to_end` to write directly into the output Vec's spare
/// capacity, avoiding the double-copy through an intermediate stack buffer.
/// The `Take` wrapper enforces the size limit without per-chunk checking.
///
/// `init_cap` bytes are reserved up front, so callers derive it from the
/// input; a failed reservation is reported as an error instead of aborting.
/// Large spare capacity is released before the output is returned.
///
/// The errors of `decoder` are reported as [`ComprsError::Corrupt`], except
/// [`std::io::ErrorKind::OutOfMemory`], which `read_to_end` returns when the
/// output cannot grow: that is a [`ComprsError::Operation`], like a failed
/// reservation.
pub fn decompress_with_limit(
    decoder: impl std::io::Read,
    max_size: usize,
    init_cap: usize,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    use std::io::Read;
    let mut output = Vec::new();
    output
        .try_reserve_exact(init_cap)
        .map_err(|e| ComprsError::Operation {
            context,
            source: e.into(),
        })?;
    // Known limit: the gzip decoder, MultiGzDecoder, reports input that ends
    // inside a member as an UnexpectedEof error, the kind of error it also
    // gives for a few bytes of garbage after a member. Such input is
    // therefore classified as corrupt rather than truncated; its message is
    // unchanged.
    decoder
        .take((max_size as u64).saturating_add(1))
        .read_to_end(&mut output)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::OutOfMemory => ComprsError::Operation {
                context,
                source: e.into(),
            },
            _ => ComprsError::Corrupt {
                context,
                source: e.into(),
            },
        })?;
    if output.len() > max_size {
        return Err(ComprsError::SizeLimit {
            context,
            limit: max_size,
        });
    }
    Ok(finish_output(output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finish_output_releases_large_spare_capacity_only() {
        let mut small = Vec::with_capacity(4096 + 100);
        small.extend_from_slice(&[1; 100]);
        assert_eq!(finish_output(small).capacity(), 4096 + 100);

        let mut large = Vec::with_capacity(100_000 + 100_000 / 8);
        large.extend_from_slice(&[1; 100_000]);
        assert_eq!(finish_output(large).capacity(), 100_000 + 100_000 / 8);

        let mut oversized = Vec::with_capacity(8_000_000);
        oversized.extend_from_slice(&[1; 19]);
        let output = finish_output(oversized);
        assert_eq!(output, [1; 19]);
        assert!(output.capacity() <= 19 + 4096, "{}", output.capacity());
    }

    /// A decoder that fails with an error of the given kind.
    struct FailingDecoder(std::io::ErrorKind);

    impl std::io::Read for FailingDecoder {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(self.0.into())
        }
    }

    #[test]
    fn decompress_with_limit_tells_failed_allocations_from_corrupt_data() {
        let corrupt = FailingDecoder(std::io::ErrorKind::InvalidData);
        assert!(matches!(
            decompress_with_limit(corrupt, 1024, 0, "test"),
            Err(ComprsError::Corrupt { .. })
        ));
        // The error of read_to_end when the output cannot grow.
        let out_of_memory = FailingDecoder(std::io::ErrorKind::OutOfMemory);
        assert!(matches!(
            decompress_with_limit(out_of_memory, 1024, 0, "test"),
            Err(ComprsError::Operation { .. })
        ));
    }

    /// A one-shot function, called with its input and, for the decoders that
    /// take one, an output limit.
    type OneShot = fn(&[u8], usize) -> Result<Vec<u8>, ComprsError>;

    /// A named one-shot function.
    type Named = (&'static str, OneShot);

    const DICT: &[u8] = b"a dictionary of the kind that the dictionary functions take";

    /// Every one-shot encoder, each with every one-shot decoder of its
    /// output.
    const CODECS: &[(&str, OneShot, &[Named])] = &[
        (
            "zstd::compress",
            |data, _| zstd::compress(data, None),
            &[
                ("zstd::decompress", |data, _| zstd::decompress(data)),
                (
                    "zstd::decompress_with_capacity",
                    zstd::decompress_with_capacity,
                ),
                ("detect::decompress", |data, _| detect::decompress(data)),
                (
                    "detect::decompress_with_capacity",
                    detect::decompress_with_capacity,
                ),
            ],
        ),
        (
            "zstd_stream::CompressContext",
            |data, _| {
                let mut ctx = zstd_stream::CompressContext::new(None)?;
                let mut output = ctx.transform(data)?;
                output.extend(ctx.finish()?);
                Ok(output)
            },
            // Frames without a content size, which the decoders decode
            // through the streaming decoder.
            &[
                ("zstd::decompress", |data, _| zstd::decompress(data)),
                (
                    "zstd::decompress_with_capacity",
                    zstd::decompress_with_capacity,
                ),
            ],
        ),
        (
            "zstd::compress_with_dict",
            |data, _| zstd::compress_with_dict(data, DICT, None),
            &[
                ("zstd::decompress_with_dict", |data, _| {
                    zstd::decompress_with_dict(data, DICT)
                }),
                ("zstd::decompress_with_dict_with_capacity", |data, limit| {
                    zstd::decompress_with_dict_with_capacity(data, DICT, limit)
                }),
            ],
        ),
        (
            "gzip::compress",
            |data, _| gzip::compress(data, None),
            &[
                ("gzip::decompress", |data, _| gzip::decompress(data)),
                (
                    "gzip::decompress_with_capacity",
                    gzip::decompress_with_capacity,
                ),
                ("detect::decompress", |data, _| detect::decompress(data)),
            ],
        ),
        (
            "gzip::compress_with_header",
            |data, _| {
                let header = gzip::GzipHeaderOptions {
                    filename: Some("data.bin".to_string()),
                    mtime: Some(1),
                };
                gzip::compress_with_header(data, &header, None)
            },
            &[("gzip::decompress", |data, _| gzip::decompress(data))],
        ),
        (
            "gzip::deflate_compress",
            |data, _| gzip::deflate_compress(data, None),
            &[
                ("gzip::deflate_decompress", |data, _| {
                    gzip::deflate_decompress(data)
                }),
                (
                    "gzip::deflate_decompress_with_capacity",
                    gzip::deflate_decompress_with_capacity,
                ),
            ],
        ),
        (
            "brotli::compress",
            |data, _| brotli::compress(data, None),
            &[
                ("brotli::decompress", |data, _| brotli::decompress(data)),
                (
                    "brotli::decompress_with_capacity",
                    brotli::decompress_with_capacity,
                ),
                ("detect::decompress", |data, _| detect::decompress(data)),
            ],
        ),
        (
            "brotli::compress_with_dict",
            |data, _| brotli::compress_with_dict(data, DICT, None),
            &[
                ("brotli::decompress_with_dict", |data, _| {
                    brotli::decompress_with_dict(data, DICT)
                }),
                (
                    "brotli::decompress_with_dict_with_capacity",
                    |data, limit| brotli::decompress_with_dict_with_capacity(data, DICT, limit),
                ),
            ],
        ),
        (
            // Quality 10 and 11 output is checked by decoding it.
            "brotli::compress_with_dict at quality 10",
            |data, _| brotli::compress_with_dict(data, DICT, Some(10)),
            &[("brotli::decompress_with_dict", |data, _| {
                brotli::decompress_with_dict(data, DICT)
            })],
        ),
        (
            "lz4::compress",
            |data, _| lz4::compress(data),
            &[
                ("lz4::decompress", |data, _| lz4::decompress(data)),
                (
                    "lz4::decompress_with_capacity",
                    lz4::decompress_with_capacity,
                ),
                ("detect::decompress", |data, _| detect::decompress(data)),
            ],
        ),
    ];

    /// Check that `output` keeps no more spare capacity than
    /// [`finish_output`] allows.
    fn assert_tight(name: &str, input_len: usize, output: &[u8], capacity: usize) {
        let len = output.len();
        assert!(
            capacity <= len + (len / 8).max(4096),
            "{name} of {input_len} bytes returned {len} bytes in a buffer of {capacity}"
        );
    }

    #[test]
    fn one_shot_outputs_keep_little_spare_capacity() {
        let patterned: Vec<u8> = (0..8_000_000u32).map(|i| (i % 7) as u8).collect();
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let noise: Vec<u8> = (0..1_000_000)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect();
        for input in [&patterned, &noise] {
            for &(encoder, compress, decoders) in CODECS {
                // Quality 10 is slow; small inputs cover its code path.
                let input = if encoder.ends_with("quality 10") {
                    &input[..100_000]
                } else {
                    input
                };
                let compressed = compress(input, 0).unwrap();
                // Stream contexts are not one-shot functions.
                if !encoder.ends_with("Context") {
                    assert_tight(encoder, input.len(), &compressed, compressed.capacity());
                }
                for &(decoder, decompress) in decoders {
                    let output = decompress(&compressed, input.len()).unwrap();
                    assert!(output == input, "{decoder} of {encoder} output");
                    assert_tight(decoder, compressed.len(), &output, output.capacity());
                }
            }
        }
    }
}
