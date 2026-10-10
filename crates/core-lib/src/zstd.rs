//! Zstandard compression and decompression.

use std::cell::RefCell;

use zstd::zstd_safe::{self, CCtx, CParameter, DCtx, ResetDirective};

use crate::dictionary::Dictionary;
use crate::zstd_stream::{decode_error, zstd_error};
use crate::{ComprsError, IntArg};

/// Default compression level for zstd (same as the C library default).
pub const DEFAULT_LEVEL: i32 = 3;

/// zstd compression levels: negative levels for fast mode down to -131072
/// (`ZSTD_minCLevel()`), and 1 (fastest) to 22 (best compression). Level 0
/// selects [`DEFAULT_LEVEL`].
pub const LEVEL: IntArg<i32> = IntArg {
    name: "zstd compression level",
    min: -131072,
    max: 22,
};

/// The level that zstd compresses at for a checked `level`: level 0 selects
/// [`DEFAULT_LEVEL`].
pub(crate) fn effective_level(level: i32) -> i32 {
    if level == 0 { DEFAULT_LEVEL } else { level }
}

/// The number of worker threads that compress zstd data: 0 compresses on the
/// calling thread, and 1 to 256 on that many threads, which zstd starts in
/// addition to it.
///
/// 256 is `ZSTDMT_NBWORKERS_MAX` on 64-bit targets (zstd 1.5.7,
/// `zstdmt_compress.h`), which all native builds are; zstd caps the number
/// at 64 on 32-bit targets. Builds without the `zstdmt` feature, such as the
/// WebAssembly build, accept only 0.
pub const WORKERS: IntArg<u32> = IntArg {
    name: "zstd workers",
    min: 0,
    max: 256,
};

/// Largest input, in bytes, that zstd compresses in one call on the calling
/// thread whatever the number of workers (512 KiB): with the input's size
/// known, `ZSTD_CCtx_init_compressStream2` sets the number of workers to 0
/// if the size is at most `ZSTDMT_JOBSIZE_MIN` (zstd 1.5.7,
/// `zstd_compress.c` and `zstdmt_compress.h`).
const MAX_SINGLE_THREADED_INPUT: usize = 512 * 1024;

/// Default maximum dictionary size (110 KB, zstd default).
pub const DEFAULT_MAX_DICT_SIZE: usize = 110 * 1024;

/// Largest `max_dict_size` that [`train_dictionary`] accepts (16 MiB).
///
/// zstd recommends dictionaries of about 100 KB, trained on about 100 times
/// as much sample data, so a dictionary of this size already calls for more
/// than a gigabyte of samples. Training allocates several buffers of
/// `max_dict_size` bytes, which the bound keeps within reach of 32-bit and
/// WASM address spaces.
pub const MAX_DICT_SIZE: usize = 16 * 1024 * 1024;

/// The `max_dict_size` of [`train_dictionary`]: at most [`MAX_DICT_SIZE`].
pub const DICT_SIZE: IntArg<usize> = IntArg {
    name: "maxDictSize",
    min: 0,
    max: MAX_DICT_SIZE,
};

/// The most that a zstd frame can expand: a 4-byte RLE block (a 3-byte block
/// header and the byte to repeat) decodes to at most 128 KiB.
const MAX_EXPANSION: u64 = 128 * 1024 / 4;

/// Compress data using Zstandard.
///
/// The output is the same as that of `zstd::bulk::compress`. The compression
/// context is reused across the calls on a thread; see [`with_cctx`].
pub fn compress(data: &[u8], level: Option<i32>) -> Result<Vec<u8>, ComprsError> {
    let level = LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;

    with_cctx(|cctx| {
        cctx.set_parameter(CParameter::CompressionLevel(level))
            .map_err(|code| ComprsError::Operation {
                context: "zstd compress",
                source: zstd_error(code),
            })?;
        compress_all(cctx, data, "zstd compress")
    })
}

/// Compress data using Zstandard on `workers` threads.
///
/// 0 workers is [`compress`], and so is an input of up to 512 KiB, which
/// zstd compresses on the calling thread without starting any threads:
/// both give the output of [`compress`] and reuse the thread's context.
/// With 1 or more workers and a larger input, zstd starts that many threads
/// for the call and splits the input into jobs, which the threads compress
/// in parallel; the threads stop before the call returns. zstd sizes the
/// jobs from the window of the level: four times the window and at least
/// 1 MiB, which makes 2 MiB at level 1 and 8 MiB at level 3. Only an input
/// that spans several jobs compresses faster. The output is the same for
/// any number of workers from 1 up, but can differ from that of
/// [`compress`].
///
/// Workers cost memory: zstd buffers the input of `workers + 3` jobs, which
/// makes 56 MiB for 4 workers at level 3, and gives each worker a context
/// of its own.
///
/// `workers` must be within [`WORKERS`]. Builds without the `zstdmt`
/// feature accept only 0, and report any other number as
/// [`ComprsError::InvalidArg`].
pub fn compress_with_workers(
    data: &[u8],
    level: Option<i32>,
    workers: u32,
) -> Result<Vec<u8>, ComprsError> {
    // zstd would compress a short input on this thread anyway, with the
    // output of `compress`, which reuses the thread's context instead of
    // creating one.
    if check_workers(workers)? == 0 || data.len() <= MAX_SINGLE_THREADED_INPUT {
        return compress(data, level);
    }
    compress_on_workers(data, &[], level, workers, "zstd compress")
}

/// Decompress Zstandard-compressed data.
///
/// The input may hold several frames, including skippable ones. The output
/// is limited to [`crate::MAX_DECOMPRESSED_SIZE`] bytes.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, ComprsError> {
    decompress_with_limit(data, &[], crate::MAX_DECOMPRESSED_SIZE, "zstd decompress")
}

/// Decompress Zstandard-compressed data with explicit capacity.
///
/// `capacity` limits the output size; the output buffer grows with the
/// decompressed data instead of being allocated at that size. It also
/// bounds the window of a frame, as for
/// [`crate::zstd_stream::DecompressContext::new`].
pub fn decompress_with_capacity(data: &[u8], capacity: usize) -> Result<Vec<u8>, ComprsError> {
    decompress_with_limit(data, &[], capacity, "zstd decompress")
}

/// Train a zstd dictionary from sample data.
///
/// `max_dict_size` must not exceed [`MAX_DICT_SIZE`].
pub fn train_dictionary(samples: &[Vec<u8>], max_dict_size: usize) -> Result<Vec<u8>, ComprsError> {
    let max_dict_size = DICT_SIZE.check(max_dict_size)?;
    zstd::dict::from_samples(samples, max_dict_size).map_err(|e| ComprsError::Operation {
        context: "zstd dictionary training",
        source: e.into(),
    })
}

/// Compress data using Zstandard with a pre-trained dictionary.
pub fn compress_with_dict(
    data: &[u8],
    dict: &[u8],
    level: Option<i32>,
) -> Result<Vec<u8>, ComprsError> {
    let level = LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;

    let mut compressor = zstd::bulk::Compressor::with_dictionary(level, dict).map_err(|e| {
        ComprsError::Operation {
            context: "zstd compressor init",
            source: e.into(),
        }
    })?;

    compressor
        .compress(data)
        .map(crate::finish_output)
        .map_err(|e| ComprsError::Operation {
            context: "zstd compress with dict",
            source: e.into(),
        })
}

/// Compress data using Zstandard with a pre-trained dictionary on `workers`
/// threads.
///
/// 0 workers is [`compress_with_dict`], with the same output. Otherwise
/// `workers` works as in [`compress_with_workers`]; only the first job
/// refers to the dictionary.
pub fn compress_with_dict_and_workers(
    data: &[u8],
    dict: &[u8],
    level: Option<i32>,
    workers: u32,
) -> Result<Vec<u8>, ComprsError> {
    if check_workers(workers)? == 0 {
        return compress_with_dict(data, dict, level);
    }
    compress_on_workers(data, dict, level, workers, "zstd compress with dict")
}

/// Check `workers` against [`WORKERS`] and the build: without the `zstdmt`
/// feature, only 0 is accepted.
pub(crate) fn check_workers(workers: u32) -> Result<u32, ComprsError> {
    let workers = WORKERS.check(workers)?;
    if workers > 0 && !cfg!(feature = "zstdmt") {
        return Err(ComprsError::InvalidArg(
            "zstd workers are not supported in this build".to_string(),
        ));
    }
    Ok(workers)
}

/// Compress `data` with `dict` (empty for none) on `workers` threads, for
/// [`compress_with_workers`] and [`compress_with_dict_and_workers`].
///
/// The context is created for the call and never cached: a cached context
/// would keep the pool of worker threads alive on every thread that used
/// it.
fn compress_on_workers(
    data: &[u8],
    dict: &[u8],
    level: Option<i32>,
    workers: u32,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    let level = LEVEL.check(level.unwrap_or(DEFAULT_LEVEL))?;
    let mut cctx = crate::zstd_stream::encoder(level, workers, dict).map_err(|code| {
        ComprsError::Operation {
            context: "zstd compressor init",
            source: zstd_error(code),
        }
    })?;
    compress_all(&mut cctx, data, context)
}

/// Compress `data` into one frame with the parameters of `cctx`.
fn compress_all(
    cctx: &mut CCtx<'_>,
    data: &[u8],
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    compress_bounded(data.len(), context, |output| cctx.compress2(output, data))
}

/// Run `compress`, which compresses `len` bytes into one frame, with an
/// output buffer that has room for `compress_bound` bytes, which the frame
/// never exceeds, with workers too.
fn compress_bounded(
    len: usize,
    context: &'static str,
    compress: impl FnOnce(&mut Vec<u8>) -> zstd_safe::SafeResult,
) -> Result<Vec<u8>, ComprsError> {
    let mut output = output_buffer(zstd_safe::compress_bound(len), context)?;
    compress(&mut output).map_err(|code| ComprsError::Operation {
        context,
        source: zstd_error(code),
    })?;
    Ok(crate::finish_output(output))
}

/// An empty buffer with room for `capacity` bytes, reporting a failed
/// allocation as an error instead of aborting.
fn output_buffer(capacity: usize, context: &'static str) -> Result<Vec<u8>, ComprsError> {
    let mut output = Vec::new();
    output
        .try_reserve_exact(capacity)
        .map_err(|e| ComprsError::Operation {
            context,
            source: e.into(),
        })?;
    Ok(output)
}

/// Decompress Zstandard-compressed data that was compressed with a dictionary.
///
/// The output is limited to [`crate::MAX_DECOMPRESSED_SIZE`] bytes.
pub fn decompress_with_dict(data: &[u8], dict: &[u8]) -> Result<Vec<u8>, ComprsError> {
    decompress_with_limit(
        data,
        dict,
        crate::MAX_DECOMPRESSED_SIZE,
        "zstd decompress with dict",
    )
}

/// Decompress Zstandard-compressed data with a dictionary and explicit capacity.
///
/// `capacity` limits the output size and the window of a frame, as in
/// [`decompress_with_capacity`].
pub fn decompress_with_dict_with_capacity(
    data: &[u8],
    dict: &[u8],
    capacity: usize,
) -> Result<Vec<u8>, ComprsError> {
    decompress_with_limit(data, dict, capacity, "zstd decompress with dict")
}

/// Decompress `data` with `dict` (empty for none) into at most `limit` bytes.
///
/// When [`declared_output_size`] knows the exact output size, the frames are
/// decoded straight into a buffer of that size. Otherwise the streaming
/// decoder grows the output as it decodes, so frames without a content size
/// never reserve `limit` bytes up front.
fn decompress_with_limit(
    data: &[u8],
    dict: &[u8],
    limit: usize,
    context: &'static str,
) -> Result<Vec<u8>, ComprsError> {
    crate::require_input(data, "zstd")?;

    let Some(size) = declared_output_size(data, limit, context)? else {
        // Start at the input size: incompressible data then fits as is, and
        // compressible data grows the buffer geometrically.
        return with_dctx(dict, limit, |dctx| {
            crate::zstd_stream::decompress_all(dctx, data, limit, data.len(), context)
        })
        .map(crate::finish_output);
    };

    let mut output = output_buffer(size, context)?;
    with_dctx(dict, limit, |dctx| {
        dctx.decompress(&mut output, data)
            .map_err(|code| decode_error(code, context))
    })?;
    Ok(crate::finish_output(output))
}

/// Compress data using Zstandard with a prepared [`Dictionary`] on
/// `workers` threads.
///
/// Unlike [`compress_with_dict`], the call does not digest the dictionary:
/// it uses the compression dictionary that `dict` keeps for `level`. The
/// output decodes with [`decompress_prepared`], and with
/// [`decompress_with_dict`] and the bytes of `dict`, but can differ from
/// that of [`compress_with_dict`] at the same level: zstd compresses small
/// inputs with the parameters that the prepared dictionary was digested
/// for.
///
/// `None` selects the level of `dict` ([`Dictionary::level`]), and
/// `Some(0)` selects [`DEFAULT_LEVEL`], as [`LEVEL`] documents, whatever
/// the level of `dict`. Any level other than that of `dict` needs a
/// compression dictionary of its own, which `dict` prepares on first use
/// and keeps, as [`Dictionary`] describes: it adds to the memory of `dict`,
/// and can make `dict` drop another level that it kept.
///
/// 0 workers compress on the calling thread, with the context that the
/// thread caches. So does an input of up to 512 KiB with any number of
/// workers, since zstd would compress it on the calling thread anyway: its
/// output does not depend on `workers`. With 1 or more workers and a larger
/// input, `workers` works as in [`compress_with_dict_and_workers`], with a
/// context for the call that refers to the prepared dictionary.
///
/// Fails with [`ComprsError::InvalidArg`] for a brotli dictionary, then for
/// invalid `workers`, then for an invalid `level`.
pub fn compress_prepared(
    data: &[u8],
    dict: &Dictionary,
    level: Option<i32>,
    workers: u32,
) -> Result<Vec<u8>, ComprsError> {
    const CONTEXT: &str = "zstd compress with dict";
    let prepared_level = dict.zstd_level()?;
    let workers = check_workers(workers)?;
    let level = match level {
        Some(level) => effective_level(LEVEL.check(level)?),
        None => prepared_level,
    };
    let cdict = dict.zstd_cdict(level)?;

    // A context for the workers would compress a short input on this thread
    // anyway, after its creation.
    if workers == 0 || data.len() <= MAX_SINGLE_THREADED_INPUT {
        return with_cctx(|cctx| {
            compress_bounded(data.len(), CONTEXT, |output| {
                cctx.compress_using_cdict(output, data, &cdict)
            })
        });
    }
    // A context for the call, as in compress_on_workers. It refers to the
    // compression dictionary, whose level replaces the context's.
    let mut cctx = CCtx::create();
    cctx.set_parameter(CParameter::NbWorkers(workers))
        .and_then(|_| cctx.ref_cdict(&cdict))
        .map_err(|code| ComprsError::Operation {
            context: "zstd compressor init",
            source: zstd_error(code),
        })?;
    compress_all(&mut cctx, data, CONTEXT)
}

/// Decompress Zstandard-compressed data with a prepared [`Dictionary`] into
/// at most `limit` bytes.
///
/// This is [`decompress_with_dict_with_capacity`] with the decompression
/// dictionary that `dict` prepared, instead of one digested for the call:
/// `limit` bounds the window of a frame as `capacity` does there.
/// The input may hold several frames, including skippable ones and frames
/// compressed without a dictionary.
///
/// Fails with [`ComprsError::InvalidArg`] for a brotli dictionary.
pub fn decompress_prepared(
    data: &[u8],
    dict: &Dictionary,
    limit: usize,
) -> Result<Vec<u8>, ComprsError> {
    const CONTEXT: &str = "zstd decompress with dict";
    let ddict = dict.zstd_ddict()?;
    crate::require_input(data, "zstd")?;

    let Some(size) = declared_output_size(data, limit, CONTEXT)? else {
        // The streaming decoder takes the dictionary as a reference, which
        // the context then borrows: the context that the thread caches
        // outlives any dictionary, so this one is created for the call.
        let mut dctx = DCtx::create();
        crate::zstd_stream::limit_window(&mut dctx, limit)
            .and_then(|()| dctx.ref_ddict(ddict))
            .map_err(|code| ComprsError::Operation {
                context: "zstd decompressor init",
                source: zstd_error(code),
            })?;
        return crate::zstd_stream::decompress_all(&mut dctx, data, limit, data.len(), CONTEXT)
            .map(crate::finish_output);
    };

    let mut output = output_buffer(size, CONTEXT)?;
    with_dctx(&[], limit, |dctx| {
        dctx.decompress_using_ddict(&mut output, data, ddict)
            .map_err(|code| decode_error(code, CONTEXT))
    })?;
    Ok(crate::finish_output(output))
}

/// Largest context, in bytes, that a thread keeps for its next one-shot
/// call (8 MiB).
///
/// Contexts for small inputs need far less, while a high level or a large
/// input can make the workspace tens of megabytes, which a thread should
/// not hold on to between calls.
const MAX_CACHED_CONTEXT_SIZE: usize = 8 * 1024 * 1024;

thread_local! {
    /// The compression context of [`with_cctx`].
    static CCTX: RefCell<Option<CCtx<'static>>> = const { RefCell::new(None) };
    /// The decompression context of [`with_dctx`].
    static DCTX: RefCell<Option<DCtx<'static>>> = const { RefCell::new(None) };
}

/// Run `f` with the thread's compression context, creating it on first use.
///
/// Creating and initializing a context costs more than compressing a small
/// message, so the one-shot calls on a thread share one. The context comes
/// with default parameters and no dictionary, and is cached again only if
/// `f` succeeds and the context holds at most [`MAX_CACHED_CONTEXT_SIZE`]
/// bytes. A nested call gets a new context of its own.
///
/// `f` may compress with a prepared dictionary through
/// `compress_using_cdict`, which applies it to that frame only: zstd sets
/// up every frame from the context's parameters, which the reset before
/// each call restores.
fn with_cctx<T>(
    f: impl FnOnce(&mut CCtx<'static>) -> Result<T, ComprsError>,
) -> Result<T, ComprsError> {
    let cached = CCTX.try_with(RefCell::take).ok().flatten();
    let mut cctx = match cached {
        Some(mut cctx) => {
            cctx.reset(ResetDirective::SessionAndParameters)
                .map_err(|code| ComprsError::Operation {
                    context: "zstd compressor init",
                    source: zstd_error(code),
                })?;
            cctx
        }
        None => CCtx::create(),
    };
    let result = f(&mut cctx)?;
    if cctx.sizeof() <= MAX_CACHED_CONTEXT_SIZE {
        // A thread that is exiting has no cache left; the context is dropped.
        let _ = CCTX.try_with(|cached| cached.replace(Some(cctx)));
    }
    Ok(result)
}

/// Run `f` with a decompression context for `dict` (empty for none), whose
/// window is bounded for an output limit of `limit` bytes (see
/// [`crate::zstd_stream::limit_window`]).
///
/// Without a dictionary, this is the thread's cached context, reused as in
/// [`with_cctx`]. Its reset restores zstd's default window bound, so every
/// call bounds the window for its own limit again. A dictionary is loaded
/// into a new context, so that the cached one never holds a dictionary. `f`
/// may decompress with a prepared dictionary through
/// `decompress_using_ddict`, which applies it to that call's frames only.
fn with_dctx<T>(
    dict: &[u8],
    limit: usize,
    f: impl FnOnce(&mut DCtx<'static>) -> Result<T, ComprsError>,
) -> Result<T, ComprsError> {
    let init_error = |code| ComprsError::Operation {
        context: "zstd decompressor init",
        source: zstd_error(code),
    };
    if !dict.is_empty() {
        let mut dctx = crate::zstd_stream::decoder(dict, limit).map_err(init_error)?;
        return f(&mut dctx);
    }

    let cached = DCTX.try_with(RefCell::take).ok().flatten();
    let mut dctx = match cached {
        Some(mut dctx) => {
            dctx.reset(ResetDirective::SessionAndParameters)
                .and_then(|_| crate::zstd_stream::limit_window(&mut dctx, limit))
                .map_err(init_error)?;
            dctx
        }
        None => crate::zstd_stream::decoder(&[], limit).map_err(init_error)?,
    };
    let result = f(&mut dctx)?;
    if dctx.sizeof() <= MAX_CACHED_CONTEXT_SIZE {
        let _ = DCTX.try_with(|cached| cached.replace(Some(dctx)));
    }
    Ok(result)
}

/// The total content size that the frames in `data` declare, if it can size
/// the output buffer: every frame declares its content size (skippable frames
/// declare 0), the frames span all of `data`, and the total is no more than
/// `data` can expand to, so forged headers cannot reserve more memory than
/// valid input of the same length could fill.
///
/// Fails with [`ComprsError::SizeLimit`] if the declared total exceeds
/// `limit`.
fn declared_output_size(
    data: &[u8],
    limit: usize,
    context: &'static str,
) -> Result<Option<usize>, ComprsError> {
    let mut total: u64 = 0;
    let mut rest = data;
    while !rest.is_empty() {
        let frame_len = match zstd_safe::find_frame_compressed_size(rest) {
            Ok(len) if len > 0 && len <= rest.len() => len,
            _ => return Ok(None),
        };
        let Ok(Some(size)) = zstd_safe::get_frame_content_size(rest) else {
            return Ok(None);
        };
        total = total.saturating_add(size);
        rest = &rest[frame_len..];
    }
    if total > limit as u64 {
        return Err(ComprsError::SizeLimit { context, limit });
    }
    if total > (data.len() as u64).saturating_mul(MAX_EXPANSION) {
        return Ok(None);
    }
    Ok(Some(total as usize))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decompress_rejects_empty_input() {
        let dict = b"zstd dictionary content ".repeat(20);
        for result in [
            decompress(&[]),
            decompress_with_capacity(&[], 1024),
            decompress_with_dict(&[], &dict),
            decompress_with_dict_with_capacity(&[], &dict, 1024),
        ] {
            assert!(matches!(result, Err(ComprsError::Truncated("zstd"))));
        }
    }

    const DICT: &[u8] = b"zstd dictionary content, zstd dictionary content, zstd";

    /// Compress `data` the way streaming encoders do: the frame does not
    /// declare its content size.
    fn compress_without_content_size(data: &[u8]) -> Vec<u8> {
        let mut ctx = crate::zstd_stream::CompressContext::new(None).unwrap();
        let mut frame = ctx.transform(data).unwrap();
        frame.extend(ctx.finish().unwrap());
        assert!(matches!(
            zstd::zstd_safe::get_frame_content_size(&frame),
            Ok(None)
        ));
        frame
    }

    /// Like [`compress_without_content_size`], with [`DICT`].
    fn compress_with_dict_without_content_size(data: &[u8]) -> Vec<u8> {
        let mut ctx = crate::zstd_stream::CompressDictContext::new(DICT, None).unwrap();
        let mut frame = ctx.transform(data).unwrap();
        frame.extend(ctx.finish().unwrap());
        frame
    }

    /// A skippable frame (RFC 8878, section 3.1.2) carrying `payload`.
    fn skippable_frame(payload: &[u8]) -> Vec<u8> {
        let mut frame = 0x184D_2A50u32.to_le_bytes().to_vec();
        frame.extend((payload.len() as u32).to_le_bytes());
        frame.extend(payload);
        frame
    }

    /// Text that compresses well but is not a single repeated byte.
    fn text(len: usize) -> Vec<u8> {
        b"comprs sizes zstd output from the data. "
            .iter()
            .copied()
            .cycle()
            .take(len)
            .collect()
    }

    /// A frame that holds `content` in one raw block but declares
    /// `content_size` as its content size.
    fn frame_declaring(content_size: u64, content: &[u8]) -> Vec<u8> {
        let mut frame = vec![0x28, 0xB5, 0x2F, 0xFD];
        // Frame header descriptor (8-byte content size), 1 KiB window.
        frame.extend([0xC0, 0x00]);
        frame.extend(content_size.to_le_bytes());
        // Block header: last block, raw, `content.len()` bytes.
        let block_header = 1 | ((content.len() as u32) << 3);
        frame.extend(&block_header.to_le_bytes()[..3]);
        frame.extend(content);
        frame
    }

    #[test]
    fn declared_output_size_sums_declared_sizes_of_complete_frames() {
        let a = compress(&text(1000), None).unwrap();
        let b = compress(&text(3000), None).unwrap();
        let skippable = skippable_frame(b"metadata");
        let input = [&a[..], &skippable[..], &b[..]].concat();
        assert_eq!(
            declared_output_size(&input, 4000, "test").unwrap(),
            Some(4000)
        );
        assert_eq!(
            declared_output_size(&skippable, 0, "test").unwrap(),
            Some(0)
        );

        let without_size = compress_without_content_size(b"hello");
        let mixed = [&a[..], &without_size[..]].concat();
        let trailing = [&a[..], &[0]].concat();
        for input in [&without_size[..], &mixed, &a[..a.len() - 1], &trailing] {
            assert_eq!(
                declared_output_size(input, usize::MAX, "test").unwrap(),
                None
            );
        }
    }

    #[test]
    fn declared_output_size_rejects_sizes_over_the_limit() {
        let frame = frame_declaring(5, b"hello");
        assert_eq!(decompress(&frame).unwrap(), b"hello");
        assert!(matches!(
            declared_output_size(&frame, 4, "zstd decompress"),
            Err(ComprsError::SizeLimit { limit: 4, .. })
        ));
        assert!(matches!(
            decompress_with_capacity(&frame, 4),
            Err(ComprsError::SizeLimit { limit: 4, .. })
        ));
    }

    #[test]
    fn declared_output_size_ignores_sizes_the_frames_cannot_fill() {
        // 22 bytes of input decode to at most 22 * 32 KiB, so the declared
        // 200 MiB must not be allocated before decoding finds the frame
        // corrupt.
        let forged = frame_declaring(200 * 1024 * 1024, b"hello");
        assert_eq!(
            declared_output_size(&forged, usize::MAX, "test").unwrap(),
            None
        );
        assert!(matches!(
            decompress(&forged),
            Err(ComprsError::Corrupt { .. })
        ));
    }

    #[test]
    fn decompress_reports_frames_that_do_not_fill_their_size_as_corrupt() {
        // The declared size is trusted, so the frame is decoded straight into
        // a buffer of that size rather than by the streaming decoder.
        let frame = frame_declaring(10, b"hello");
        assert_eq!(
            declared_output_size(&frame, usize::MAX, "test").unwrap(),
            Some(10)
        );
        for result in [decompress(&frame), decompress_with_capacity(&frame, 10)] {
            let err = result.unwrap_err();
            assert!(matches!(err, ComprsError::Corrupt { .. }), "{err:?}");
            assert_eq!(
                err.to_string(),
                "zstd decompress failed: Data corruption detected"
            );
        }
    }

    #[test]
    fn decompress_sizes_output_from_the_data_without_a_content_size() {
        let small = compress_without_content_size(b"hello");
        let small_dict = compress_with_dict_without_content_size(b"hello");
        for output in [
            decompress(&small).unwrap(),
            decompress_with_capacity(&small, 1 << 40).unwrap(),
            decompress_with_dict(&small_dict, DICT).unwrap(),
            decompress_with_dict_with_capacity(&small_dict, DICT, 1 << 40).unwrap(),
            crate::detect::decompress(&small).unwrap(),
        ] {
            assert_eq!(output, b"hello");
            assert!(output.capacity() < 1024, "capacity {}", output.capacity());
        }

        let original = text(200_000);
        let output = decompress(&compress_without_content_size(&original)).unwrap();
        assert_eq!(output, original);
        assert!(
            output.capacity() <= 2 * original.len(),
            "capacity {}",
            output.capacity()
        );
    }

    #[test]
    fn decompress_allocates_the_declared_content_size_exactly() {
        let original = text(200_000);
        let output = decompress(&compress(&original, None).unwrap()).unwrap();
        assert_eq!(output, original);
        assert_eq!(output.capacity(), original.len());
    }

    #[test]
    fn decompress_treats_capacity_as_a_limit_only() {
        // Capacities that cannot be allocated used to abort the process.
        for frame in [
            compress(b"hello", None).unwrap(),
            compress_without_content_size(b"hello"),
        ] {
            for capacity in [1 << 40, usize::MAX] {
                let output = decompress_with_capacity(&frame, capacity).unwrap();
                assert_eq!(output, b"hello");
                assert!(output.capacity() < 1024, "capacity {}", output.capacity());
            }
        }
        for frame in [
            compress_with_dict(b"hello", DICT, None).unwrap(),
            compress_with_dict_without_content_size(b"hello"),
        ] {
            for capacity in [1 << 40, usize::MAX] {
                let output = decompress_with_dict_with_capacity(&frame, DICT, capacity).unwrap();
                assert_eq!(output, b"hello");
            }
        }
    }

    #[test]
    fn decompress_reports_output_over_the_limit() {
        let original = text(4096);
        for frame in [
            compress(&original, None).unwrap(),
            compress_without_content_size(&original),
        ] {
            assert_eq!(decompress_with_capacity(&frame, 4096).unwrap(), original);
            let err = decompress_with_capacity(&frame, 4095).unwrap_err();
            assert_eq!(
                err.to_string(),
                "zstd decompress exceeded maximum size of 4095 bytes"
            );
        }
        for frame in [
            compress_with_dict(&original, DICT, None).unwrap(),
            compress_with_dict_without_content_size(&original),
        ] {
            assert_eq!(
                decompress_with_dict_with_capacity(&frame, DICT, 4096).unwrap(),
                original
            );
            let err = decompress_with_dict_with_capacity(&frame, DICT, 4095).unwrap_err();
            assert_eq!(
                err.to_string(),
                "zstd decompress with dict exceeded maximum size of 4095 bytes"
            );
        }
    }

    #[test]
    fn decompress_stops_a_bomb_without_a_content_size_at_the_limit() {
        let bomb = compress_without_content_size(&vec![0u8; 8 * 1024 * 1024]);
        assert!(matches!(
            decompress_with_capacity(&bomb, 64 * 1024),
            Err(ComprsError::SizeLimit { limit: 65536, .. })
        ));
    }

    #[test]
    fn decompress_accepts_concatenated_frames() {
        let (a, b) = (vec![b'a'; 4096], vec![b'b'; 4096]);
        let expected = [&a[..], &b[..]].concat();
        let inputs = [
            [compress(&a, None).unwrap(), compress(&b, None).unwrap()].concat(),
            [
                compress(&a, None).unwrap(),
                compress_without_content_size(&b),
            ]
            .concat(),
            [
                compress_without_content_size(&a),
                compress_without_content_size(&b),
            ]
            .concat(),
        ];
        for input in &inputs {
            assert_eq!(decompress(input).unwrap(), expected);
            assert_eq!(
                decompress_with_capacity(input, expected.len()).unwrap(),
                expected
            );
            assert!(matches!(
                decompress_with_capacity(input, expected.len() - 1),
                Err(ComprsError::SizeLimit { .. })
            ));
            assert_eq!(crate::detect::decompress(input).unwrap(), expected);
        }

        let with_size = compress_with_dict(&a, DICT, None).unwrap();
        for second in [
            compress_with_dict(&b, DICT, None).unwrap(),
            compress_with_dict_without_content_size(&b),
        ] {
            let input = [&with_size[..], &second[..]].concat();
            assert_eq!(decompress_with_dict(&input, DICT).unwrap(), expected);
            assert_eq!(
                decompress_with_dict_with_capacity(&input, DICT, expected.len()).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn decompress_skips_skippable_frames() {
        let skippable = skippable_frame(b"metadata");
        let original = text(4096);
        for frame in [
            compress(&original, None).unwrap(),
            compress_without_content_size(&original),
        ] {
            for (input, frames) in [
                ([&skippable[..], &frame[..]].concat(), 1),
                ([&frame[..], &skippable[..]].concat(), 1),
                ([&frame[..], &skippable[..], &frame[..]].concat(), 2),
            ] {
                assert_eq!(decompress(&input).unwrap(), original.repeat(frames));
            }
        }
        assert_eq!(decompress(&skippable).unwrap(), b"");
    }

    #[test]
    fn decompress_rejects_truncated_input() {
        let original = text(8000);
        for frame in [
            compress(&original, None).unwrap(),
            compress_without_content_size(&original),
        ] {
            let concatenated = [&frame[..], &frame[..frame.len() / 2]].concat();
            for input in [
                &frame[..1],
                &frame[..frame.len() / 2],
                &frame[..frame.len() - 1],
                &concatenated[..],
            ] {
                assert!(
                    matches!(decompress(input), Err(ComprsError::Truncated("zstd"))),
                    "input of {} bytes",
                    input.len()
                );
            }
        }
    }

    /// The size of the thread's cached compression context, if it has one.
    fn cached_cctx_size() -> Option<usize> {
        CCTX.with_borrow(|cctx| cctx.as_ref().map(CCtx::sizeof))
    }

    /// The size of the thread's cached decompression context, if it has one.
    fn cached_dctx_size() -> Option<usize> {
        DCTX.with_borrow(|dctx| dctx.as_ref().map(DCtx::sizeof))
    }

    /// JSON messages, one per line, that differ in their fields.
    fn json_lines(len: usize) -> Vec<u8> {
        let mut output = Vec::with_capacity(len + 128);
        let mut i: u64 = 0;
        while output.len() < len {
            let user = i * 7919 % 100_000;
            output.extend(
                format!(
                    "{{\"id\":{i},\"user\":\"user_{user}\",\"ts\":{},\"active\":{}}}\n",
                    1_700_000_000 + i * 37,
                    i.is_multiple_of(3)
                )
                .bytes(),
            );
            i += 1;
        }
        output.truncate(len);
        output
    }

    #[test]
    fn compress_matches_the_bulk_api_on_a_reused_context() {
        for data in [&b"{\"id\":1}"[..], &json_lines(100), &json_lines(100_000)] {
            for level in [-5, 1, 3, 19, 3] {
                assert!(
                    compress(data, Some(level)).unwrap()
                        == zstd::bulk::compress(data, level).unwrap(),
                    "{} bytes at level {level}",
                    data.len()
                );
                assert!(cached_cctx_size().is_some());
            }
        }
    }

    #[test]
    fn one_shot_calls_do_not_cache_large_contexts() {
        assert!(compress(b"small", Some(19)).unwrap().len() < 32);
        let small = cached_cctx_size().unwrap();
        assert!(small <= MAX_CACHED_CONTEXT_SIZE, "{small} bytes");

        // At level 19, the workspace for this input exceeds the bound.
        let data = json_lines(1536 * 1024);
        let frame = compress(&data, Some(19)).unwrap();
        assert_eq!(cached_cctx_size(), None);
        compress(b"small", None).unwrap();
        assert!(cached_cctx_size().is_some());

        assert!(decompress(&frame).unwrap() == data);
        assert!(cached_dctx_size().unwrap() <= MAX_CACHED_CONTEXT_SIZE);

        // A frame without a content size and with an 8 MiB window: the
        // streaming decoder allocates the window.
        let mut large_window = vec![0x28, 0xB5, 0x2F, 0xFD, 0x00, (23 - 10) << 3];
        let block_header = 1 | (5 << 3);
        large_window.extend(&(block_header as u32).to_le_bytes()[..3]);
        large_window.extend(b"hello");
        assert_eq!(decompress(&large_window).unwrap(), b"hello");
        assert_eq!(cached_dctx_size(), None);
    }

    #[test]
    fn decompress_recovers_from_errors_on_a_reused_context() {
        let original = text(4096);
        let with_size = compress(&original, None).unwrap();
        let without_size = compress_without_content_size(&original);
        let failures = [
            // The content is shorter than the declared size.
            decompress(&frame_declaring(10, b"hello")),
            // The declared size is too large to trust, so the streaming
            // decoder finds the frame corrupt.
            decompress(&frame_declaring(200 * 1024 * 1024, b"hello")),
            decompress(&without_size[..without_size.len() / 2]),
            decompress_with_capacity(&with_size, 4095),
            decompress_with_capacity(&without_size, 4095),
            decompress(&compress_with_dict(&original, DICT, None).unwrap()),
        ];
        for result in failures {
            assert!(result.is_err());
            assert_eq!(decompress(&with_size).unwrap(), original);
            assert_eq!(decompress(&without_size).unwrap(), original);
        }
    }

    #[test]
    fn decompress_reuses_the_context_for_concatenated_and_skippable_frames() {
        let original = text(4096);
        let skippable = skippable_frame(b"metadata");
        decompress(&compress(b"first call", None).unwrap()).unwrap();
        assert!(cached_dctx_size().is_some());
        for frame in [
            compress(&original, None).unwrap(),
            compress_without_content_size(&original),
        ] {
            let input = [&frame[..], &skippable[..], &frame[..]].concat();
            assert_eq!(decompress(&input).unwrap(), original.repeat(2));
            assert!(cached_dctx_size().is_some());
        }
        // Dictionaries are loaded into contexts of their own, so the cached
        // one still decodes frames without a dictionary.
        let with_dict = compress_with_dict(&original, DICT, None).unwrap();
        assert_eq!(decompress_with_dict(&with_dict, DICT).unwrap(), original);
        assert!(decompress(&with_dict).is_err());
        assert_eq!(
            decompress(&compress(&original, None).unwrap()).unwrap(),
            original
        );
    }

    #[test]
    fn prepared_dictionaries_leave_the_cached_contexts_without_one() {
        use crate::dictionary::DictionaryFormat;

        let original = text(4096);
        let dict = Dictionary::new(DICT, DictionaryFormat::Zstd, None).unwrap();
        let with_size = compress_prepared(&original, &dict, None, 0).unwrap();
        assert!(cached_cctx_size().is_some());
        let without_size = compress_with_dict_without_content_size(&original);
        for frame in [&with_size, &without_size] {
            let output = decompress_prepared(frame, &dict, original.len()).unwrap();
            assert_eq!(output, original);
        }
        assert!(cached_dctx_size().is_some());

        // The contexts that the calls used, which the thread still caches,
        // outlive the dictionary and hold none: the frame of the dictionary
        // does not decode without it.
        drop(dict);
        let frame = compress(&original, None).unwrap();
        assert!(frame == zstd::bulk::compress(&original, DEFAULT_LEVEL).unwrap());
        assert!(cached_cctx_size().is_some());
        assert_eq!(decompress(&frame).unwrap(), original);
        assert!(cached_dctx_size().is_some());
        assert!(decompress(&with_size).is_err());
    }

    /// A frame without a content size that declares a window of
    /// 2^`window_log` bytes, then a raw block that holds `content`.
    fn frame_with_window(window_log: u8, content: &[u8]) -> Vec<u8> {
        let mut frame = vec![0x28, 0xB5, 0x2F, 0xFD, 0x00, (window_log - 10) << 3];
        let block_header = 1 | ((content.len() as u32) << 3);
        frame.extend(&block_header.to_le_bytes()[..3]);
        frame.extend(content);
        frame
    }

    #[test]
    fn decompress_bounds_the_window_by_the_capacity() {
        use crate::dictionary::DictionaryFormat;

        // The window of 128 MiB is zstd's default limit, which a capacity of
        // more than 64 MiB keeps.
        let frame = frame_with_window(27, b"A");
        assert_eq!(
            frame,
            [0x28, 0xB5, 0x2F, 0xFD, 0x00, 0x88, 0x09, 0x00, 0x00, 0x41]
        );
        let dict = Dictionary::new(DICT, DictionaryFormat::Zstd, None).unwrap();
        let limit = crate::MAX_DECOMPRESSED_SIZE;
        for output in [
            decompress(&frame),
            decompress_with_capacity(&frame, 64 * 1024 * 1024 + 1),
            decompress_with_dict(&frame, DICT),
            decompress_with_dict_with_capacity(&frame, DICT, limit),
            decompress_prepared(&frame, &dict, limit),
            crate::detect::decompress(&frame),
            crate::detect::decompress_with_capacity(&frame, limit),
        ] {
            assert_eq!(output.unwrap(), b"A");
        }

        let small = [
            ("zstd decompress", decompress_with_capacity(&frame, 1024)),
            (
                "zstd decompress with dict",
                decompress_with_dict_with_capacity(&frame, DICT, 1024),
            ),
            (
                "zstd decompress with dict",
                decompress_prepared(&frame, &dict, 1024),
            ),
            (
                "zstd decompress",
                crate::detect::decompress_with_capacity(&frame, 1024),
            ),
        ];
        for (context, result) in small {
            let err = result.unwrap_err();
            assert!(
                matches!(err, ComprsError::SizeLimit { limit: 1024, .. }),
                "{context}: {err:?}"
            );
            assert_eq!(
                err.to_string(),
                format!("{context} exceeded maximum size of 1024 bytes")
            );
        }
    }

    #[test]
    fn decompress_rejects_windows_over_128_mib_under_any_limit() {
        // No limit accepts a window over zstd's default of 128 MiB. Limits
        // that keep that bound report it as corrupt data.
        let frame = frame_with_window(28, b"A");
        for result in [
            decompress(&frame),
            decompress_with_capacity(&frame, usize::MAX),
        ] {
            let err = result.unwrap_err();
            assert!(matches!(err, ComprsError::Corrupt { .. }), "{err:?}");
            assert_eq!(
                err.to_string(),
                "zstd decompress failed: Frame requires too much memory for decoding"
            );
        }
        // A limit that lowers the bound reports any larger window as
        // exceeding the limit.
        let err = decompress_with_capacity(&frame, 1024).unwrap_err();
        assert!(matches!(err, ComprsError::SizeLimit { .. }), "{err:?}");
    }

    #[test]
    fn cached_context_bounds_the_window_on_every_call() {
        let small = compress_without_content_size(b"hello");
        let frame = frame_with_window(27, b"A");
        let large = crate::MAX_DECOMPRESSED_SIZE;
        // The first call of each pair leaves the thread a context, which
        // the second one resets to zstd's defaults.
        for (first, second) in [(1024, 1024), (large, 1024), (1024, large)] {
            assert_eq!(decompress_with_capacity(&small, first).unwrap(), b"hello");
            assert!(cached_dctx_size().is_some());
            let result = decompress_with_capacity(&frame, second);
            if second == large {
                assert_eq!(result.unwrap(), b"A");
            } else {
                let err = result.unwrap_err();
                assert!(
                    matches!(err, ComprsError::SizeLimit { limit: 1024, .. }),
                    "capacities {first} and {second}: {err:?}"
                );
            }
        }
    }

    #[test]
    fn decompress_rejects_data_after_the_last_frame() {
        let mut input = compress(b"complete", None).unwrap();
        input.extend(b"trailing garbage");
        assert!(matches!(
            decompress(&input),
            Err(ComprsError::Corrupt { .. })
        ));
    }

    /// Input that zstd compresses in four jobs at level 1, whose jobs hold
    /// 2 MiB.
    #[cfg(feature = "zstdmt")]
    const WORKER_INPUT_LEN: usize = 8 * 1024 * 1024;

    #[cfg(feature = "zstdmt")]
    #[test]
    fn compress_with_workers_round_trips() {
        compress(b"small", None).unwrap();
        let cached = cached_cctx_size().unwrap();

        let data = json_lines(WORKER_INPUT_LEN);
        let mut frames = Vec::new();
        for workers in [1, 2, 4] {
            let frame = compress_with_workers(&data, Some(1), workers).unwrap();
            assert_eq!(
                zstd_safe::get_frame_content_size(&frame).ok().flatten(),
                Some(data.len() as u64),
                "{workers} workers"
            );
            assert!(decompress(&frame).unwrap() == data, "{workers} workers");
            frames.push(frame);
        }
        // The calls neither took the context that the thread caches nor
        // cached theirs.
        assert_eq!(cached_cctx_size(), Some(cached));
        // zstd's output does not depend on the number of workers from 1 up.
        assert!(frames[0] == frames[1] && frames[0] == frames[2]);
        // The workers compress the jobs independently, so the frame differs
        // from the one that the calling thread compresses alone.
        assert!(frames[0] != compress(&data, Some(1)).unwrap());
    }

    #[cfg(feature = "zstdmt")]
    #[test]
    fn compress_with_dict_and_workers_round_trips() {
        let data = json_lines(WORKER_INPUT_LEN);
        // The first job refers to the dictionary, so the frame does not
        // decode without it.
        let dict = &data[..64 * 1024];
        let frame = compress_with_dict_and_workers(&data, dict, Some(1), 2).unwrap();
        assert_eq!(
            zstd_safe::get_frame_content_size(&frame).ok().flatten(),
            Some(data.len() as u64)
        );
        assert!(decompress_with_dict(&frame, dict).unwrap() == data);
        assert!(decompress(&frame).is_err());
        assert!(frame == compress_with_dict_and_workers(&data, dict, Some(1), 4).unwrap());
        assert!(frame != compress_with_dict(&data, dict, Some(1)).unwrap());
    }

    #[cfg(feature = "zstdmt")]
    #[test]
    fn compress_prepared_with_workers_compresses_short_input_with_the_cached_context() {
        use crate::dictionary::DictionaryFormat;

        let dict = Dictionary::new(DICT, DictionaryFormat::Zstd, Some(1.0)).unwrap();
        // zstd compresses an input of up to 512 KiB on the calling thread
        // whatever the number of workers, so a context for the workers
        // would only cost its creation.
        let data = json_lines(MAX_SINGLE_THREADED_INPUT);
        CCTX.take();
        compress(b"small", Some(1)).unwrap();
        let small = cached_cctx_size().unwrap();
        let frame = compress_prepared(&data, &dict, None, 2).unwrap();
        // The call took the cached context, whose workspace grew for the
        // input, and gave the output of 0 workers.
        assert!(cached_cctx_size().unwrap() > small);
        assert!(frame == compress_prepared(&data, &dict, None, 0).unwrap());
        assert!(decompress_prepared(&frame, &dict, data.len()).unwrap() == data);

        // One more byte, and the workers compress it on a context for the
        // call, which leaves the cached one as it was.
        let data = json_lines(MAX_SINGLE_THREADED_INPUT + 1);
        CCTX.take();
        compress(b"small", Some(1)).unwrap();
        let frame = compress_prepared(&data, &dict, None, 2).unwrap();
        assert_eq!(cached_cctx_size(), Some(small));
        assert!(decompress_prepared(&frame, &dict, data.len()).unwrap() == data);
    }

    /// Pseudo-random bytes, which zstd stores in raw blocks.
    #[cfg(feature = "zstdmt")]
    fn random(len: usize) -> Vec<u8> {
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 32) as u8
            })
            .collect()
    }

    #[cfg(feature = "zstdmt")]
    #[test]
    fn compress_with_workers_fits_incompressible_data_in_the_bound() {
        // Each job adds its own block headers, and the jobs together still
        // fit in the buffer that compress_bound sizes for the whole input.
        let data = random(4 * 1024 * 1024);
        let frame = compress_with_workers(&data, Some(1), 2).unwrap();
        assert!(frame.len() <= zstd_safe::compress_bound(data.len()));
        assert!(decompress(&frame).unwrap() == data);
    }

    /// Compress `data` with `workers` after a short input, and check that the
    /// call took the thread's cached context, whose workspace grows for
    /// `data`, and gave the output of [`compress`].
    fn assert_compresses_with_the_cached_context(data: &[u8], workers: u32) {
        CCTX.take();
        compress(b"small", Some(1)).unwrap();
        let small = cached_cctx_size().unwrap();
        let frame = compress_with_workers(data, Some(1), workers).unwrap();
        assert!(cached_cctx_size().unwrap() > small, "{workers} workers");
        assert!(
            frame == compress(data, Some(1)).unwrap(),
            "{workers} workers"
        );
    }

    #[test]
    fn compress_with_no_workers_uses_the_cached_context() {
        // Longer than an input that zstd compresses on the calling thread
        // whatever the number of workers.
        assert_compresses_with_the_cached_context(&json_lines(MAX_SINGLE_THREADED_INPUT + 1), 0);
    }

    #[cfg(feature = "zstdmt")]
    #[test]
    fn compress_with_workers_compresses_short_input_with_the_cached_context() {
        // zstd compresses this input on the calling thread, so a new context
        // for the workers would only cost its creation.
        assert_compresses_with_the_cached_context(&json_lines(MAX_SINGLE_THREADED_INPUT), 2);
    }

    #[test]
    fn compress_with_workers_validates_its_arguments() {
        for result in [
            compress_with_workers(b"data", None, 257),
            compress_with_dict_and_workers(b"data", DICT, None, 257),
            compress_with_workers(b"data", None, u32::MAX),
            // The workers are checked before the level.
            compress_with_workers(b"data", Some(23), 257),
            compress_with_dict_and_workers(b"data", DICT, Some(23), 257),
        ] {
            let err = result.unwrap_err();
            assert!(matches!(err, ComprsError::InvalidArg(_)), "{err:?}");
            assert_eq!(
                err.to_string(),
                "zstd workers must be an integer between 0 and 256"
            );
        }
        for workers in [0, 2] {
            let err = compress_with_workers(b"data", Some(23), workers).unwrap_err();
            assert!(matches!(err, ComprsError::InvalidArg(_)), "{err:?}");
            let err = compress_with_dict_and_workers(b"data", DICT, Some(23), workers).unwrap_err();
            assert!(matches!(err, ComprsError::InvalidArg(_)), "{err:?}");
        }
        // zstd accepts the whole range. compress_with_dict_and_workers sets
        // it on a new context even for input this small, which zstd
        // compresses on the calling thread, so no threads are started.
        #[cfg(feature = "zstdmt")]
        for workers in [1, 256] {
            let frame = compress_with_dict_and_workers(b"data", DICT, None, workers).unwrap();
            assert_eq!(decompress_with_dict(&frame, DICT).unwrap(), b"data");
        }
    }

    #[cfg(not(feature = "zstdmt"))]
    #[test]
    fn compress_with_workers_needs_the_zstdmt_feature() {
        for result in [
            compress_with_workers(b"data", None, 1),
            compress_with_dict_and_workers(b"data", DICT, None, 1),
        ] {
            let err = result.unwrap_err();
            assert!(matches!(err, ComprsError::InvalidArg(_)), "{err:?}");
            assert_eq!(
                err.to_string(),
                "zstd workers are not supported in this build"
            );
        }
    }

    #[test]
    fn train_dictionary_rejects_oversized_max_dict_size() {
        let samples: Vec<Vec<u8>> = (0..100)
            .map(|i| format!(r#"{{"key":{i},"value":"item_{i}"}}"#).into_bytes())
            .collect();
        // Used to abort the process when the dictionary buffer was allocated.
        for max_dict_size in [MAX_DICT_SIZE + 1, 1 << 40, usize::MAX] {
            let err = train_dictionary(&samples, max_dict_size).unwrap_err();
            assert!(matches!(err, ComprsError::InvalidArg(_)));
            assert_eq!(
                err.to_string(),
                "maxDictSize must be an integer between 0 and 16777216"
            );
        }
        assert!(train_dictionary(&samples, MAX_DICT_SIZE).is_ok());
    }

    #[test]
    fn compression_levels() {
        let data = json_lines(100_000);
        let size = |level| {
            let compressed = compress(&data, Some(level)).unwrap();
            assert_eq!(decompress(&compressed).unwrap(), data, "level {level}");
            compressed.len()
        };
        let fast = size(1);
        let default = size(DEFAULT_LEVEL);
        let best = size(19);
        // Levels close to each other may swap places on some data.
        assert!(best <= default, "{best} bytes at level 19, {default} at 3");
        assert!(best < fast, "{best} bytes at level 19, {fast} at 1");
    }

    #[test]
    fn negative_levels() {
        let data = json_lines(100_000);
        let mut sizes = Vec::new();
        for level in [1, -1, -7, -50] {
            let compressed = compress(&data, Some(level)).unwrap();
            assert_eq!(decompress(&compressed).unwrap(), data, "level {level}");
            sizes.push(compressed.len());
        }
        // Negative levels trade compression for speed, more so the lower
        // they are.
        assert!(sizes.is_sorted(), "{sizes:?}");
        assert!(sizes[3] > sizes[0], "{sizes:?}");
    }

    #[test]
    fn level_22_max_standard() {
        let data = b"Max level test data. ".repeat(50);
        let compressed = compress(&data, Some(22)).unwrap();
        assert_eq!(decompress(&compressed).unwrap(), data);
        let compressed = compress_with_dict(&data, b"Max level", Some(22)).unwrap();
        assert_eq!(
            decompress_with_dict(&compressed, b"Max level").unwrap(),
            data
        );
    }

    #[test]
    fn dict_train_and_round_trip() {
        // Generate sample data (JSON-like patterns)
        let samples: Vec<Vec<u8>> = (0..100)
            .map(|i| {
                format!(
                    r#"{{"id":{},"name":"user_{}","email":"user{}@example.com","active":{}}}"#,
                    i,
                    i,
                    i,
                    i % 2 == 0
                )
                .into_bytes()
            })
            .collect();

        let dict = train_dictionary(&samples, DEFAULT_MAX_DICT_SIZE).unwrap();
        assert!(!dict.is_empty());
        assert!(dict.len() <= DEFAULT_MAX_DICT_SIZE);

        let original = br#"{"id":999,"name":"test_user","email":"test@example.com","active":true}"#;
        let compressed = compress_with_dict(original, &dict, None).unwrap();
        assert_eq!(decompress_with_dict(&compressed, &dict).unwrap(), original);
        assert_eq!(
            decompress_with_dict_with_capacity(&compressed, &dict, original.len()).unwrap(),
            original
        );

        // The trained dictionary makes a short message smaller, and the frame
        // names it: it does not decode without the dictionary.
        let plain = compress(original, None).unwrap();
        assert!(
            compressed.len() < plain.len(),
            "{} bytes with the dictionary, {} without",
            compressed.len(),
            plain.len()
        );
        assert!(decompress(&compressed).is_err());
    }

    #[test]
    fn compress_validates_level() {
        let data = b"test";
        for level in [23, -131073] {
            assert_eq!(
                compress(data, Some(level)).unwrap_err().to_string(),
                "zstd compression level must be an integer between -131072 and 22"
            );
        }
        assert!(compress(data, Some(22)).is_ok());
        assert!(compress(data, Some(-131072)).is_ok());
    }

    #[test]
    fn compress_decompress_round_trip() {
        let original = b"Hello from core-lib!";
        let compressed = compress(original, None).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }

    #[test]
    fn dict_round_trip_via_api() {
        let samples: Vec<Vec<u8>> = (0..100)
            .map(|i| format!(r#"{{"key":{},"value":"item_{}"}}"#, i, i).into_bytes())
            .collect();
        let dict = train_dictionary(&samples, DEFAULT_MAX_DICT_SIZE).unwrap();
        let original = br#"{"key":42,"value":"item_42"}"#;
        let compressed = compress_with_dict(original, &dict, None).unwrap();
        let decompressed = decompress_with_dict(&compressed, &dict).unwrap();
        assert_eq!(original.as_slice(), decompressed.as_slice());
    }
}
