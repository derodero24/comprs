"use strict";
exports.createZstdCompressTransform = createZstdCompressTransform;
exports.createZstdDecompressTransform = createZstdDecompressTransform;
exports.createGzipCompressTransform = createGzipCompressTransform;
exports.createGzipDecompressTransform = createGzipDecompressTransform;
exports.createDeflateCompressTransform = createDeflateCompressTransform;
exports.createDeflateDecompressTransform = createDeflateDecompressTransform;
exports.createBrotliCompressTransform = createBrotliCompressTransform;
exports.createBrotliDecompressTransform = createBrotliDecompressTransform;
exports.createZstdCompressDictTransform = createZstdCompressDictTransform;
exports.createZstdDecompressDictTransform = createZstdDecompressDictTransform;
exports.createBrotliCompressDictTransform = createBrotliCompressDictTransform;
exports.createBrotliDecompressDictTransform = createBrotliDecompressDictTransform;
exports.createDecompressTransform = createDecompressTransform;
exports.createLz4CompressTransform = createLz4CompressTransform;
exports.createLz4DecompressTransform = createLz4DecompressTransform;
const node_stream_1 = require("node:stream");
const node_worker_threads_1 = require("node:worker_threads");
const index_js_1 = require("./index.js");
const stream_schedule_js_1 = require("./stream-schedule.js");
/**
 * Largest result that the stream contexts return in memory that V8 owns. It
 * mirrors SYNC_COPY_LIMIT and ASYNC_STREAM_COPY_LIMIT in
 * crates/core/src/convert.rs, which are equal, as VIEW_LIMIT in
 * src/streams.ts does: larger results stay in the memory of the addon, as
 * external buffers.
 */
const COPY_LIMIT = 2 * 1024 * 1024;
/**
 * Whether markAsUntransferable() from node:worker_threads works in this
 * runtime. Node.js implements it; Bun 1.3 and Deno before 2.7.6 export a
 * function that throws that it is not implemented.
 */
const canMarkUntransferable = probeMarkAsUntransferable();
function probeMarkAsUntransferable() {
    try {
        (0, node_worker_threads_1.markAsUntransferable)(new ArrayBuffer(0));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Push `buf`, which a stream context returned, in chunks of at most
 * `readableHighWaterMark` bytes. The chunks are views of `buf`, not copies.
 *
 * A single input chunk can decompress to many megabytes; slicing keeps the
 * chunks that readers receive as small as those of `node:zlib`. The return
 * value of push() is ignored: backpressure still applies between input
 * chunks, as the stream calls transform() again only once readers catch up.
 *
 * The chunks of a result that is pushed in several chunks share its
 * ArrayBuffer, which V8 owns for results of up to COPY_LIMIT, so
 * transferring one chunk to a worker would detach the others. That
 * ArrayBuffer is therefore marked as untransferable, so that postMessage()
 * and structuredClone() throw a DataCloneError instead. A larger result is
 * an external buffer, which Node.js already marks as untransferable, and is
 * left alone: on Node.js 24, the mark also sets a detach key, and Node.js
 * aborts the process when it detaches such a buffer, without the key, as
 * the process or the Worker that holds it exits. Where the runtime cannot
 * mark a result, a reader that transfers a chunk while push() emits it, as
 * push() does in flowing mode, makes the stream fail instead of end without
 * the rest of the result. A result that is pushed in one chunk stays
 * transferable.
 */
function pushSliced(stream, buf) {
    const length = buf.byteLength;
    if (length === 0) {
        return;
    }
    const size = stream.readableHighWaterMark || 65536;
    if (length <= size) {
        stream.push(buf);
        return;
    }
    if (canMarkUntransferable && length <= COPY_LIMIT) {
        (0, node_worker_threads_1.markAsUntransferable)(buf.buffer);
    }
    for (let i = 0; i < length; i += size) {
        stream.push(buf.subarray(i, i + size));
        if (buf.byteLength !== length) {
            throw new Error('an output chunk was transferred, which detached the other chunks of the same result; copy a chunk with new Uint8Array(chunk) before transferring it');
        }
    }
}
/**
 * Push `output`, which a stream context returned, as pushSliced() does,
 * unless the stream has been destroyed meanwhile: a call on the thread pool
 * may settle after destroy(), and its result is dropped.
 */
function pushOutput(stream, output) {
    if (!stream.destroyed) {
        pushSliced(stream, output);
    }
}
/**
 * Run `step`, then call `callback`: at once, if the step is done, or once
 * its Promise settles. An error that the step throws or rejects with goes to
 * `callback`, except one of a call that settles after the stream has been
 * destroyed, which is dropped, as node:zlib drops it: destroy() has ended
 * the stream already. The rejection handler stays attached after destroy(),
 * so such an error is never an unhandled rejection, which would crash
 * Node.js by default.
 */
function runStep(stream, step, callback) {
    let pending;
    try {
        pending = step();
    }
    catch (err) {
        // Pass on what was thrown as it is. Under Jest, which runs this module
        // in a vm context, the errors of the native addon are not instances of
        // that context's Error, and wrapping them would drop their code.
        callback(err);
        return;
    }
    if (pending === undefined) {
        callback();
        return;
    }
    pending.then(() => callback(), (err) => callback(stream.destroyed ? null : err));
}
/**
 * Create a Transform from `transform` and `flush`, which call stream
 * contexts and push their results, at once or once a call on the thread pool
 * settles. `close` closes the contexts once the stream is destroyed, which
 * happens when it ends, fails or is destroyed early, and releases their
 * native memory right away instead of when the garbage collector gets to
 * them; a call still in flight then releases it once it settles.
 */
function closingTransform(transform, flush, close) {
    return new node_stream_1.Transform({
        // Without objectMode, every chunk written is a Buffer.
        transform(chunk, _encoding, callback) {
            runStep(this, () => transform(this, chunk), callback);
        },
        flush(callback) {
            runStep(this, () => flush(this), callback);
        },
        destroy(err, callback) {
            close();
            callback(err);
        },
    });
}
/**
 * Push the output of `flush()` and then of `finish()` of `scheduler`.
 * finish() ends the stream, and fails if the input of a decompression
 * transform did not hold the whole compressed stream.
 */
function finishTransform(stream, scheduler) {
    return (0, stream_schedule_js_1.afterOutput)(scheduler.flush(), (flushed) => {
        pushOutput(stream, flushed);
        return (0, stream_schedule_js_1.afterOutput)(scheduler.finish(), (rest) => pushOutput(stream, rest));
    });
}
/**
 * Create a Transform that feeds its input through `ctx`, a stream context
 * of `op` at `level`, which processes it as `model` adds (see
 * codecScheduler).
 */
function contextTransform(ctx, op, level, model) {
    const scheduler = (0, stream_schedule_js_1.codecScheduler)(ctx, op, level, model);
    return closingTransform((stream, chunk) => (0, stream_schedule_js_1.afterOutput)(scheduler.transform(chunk), (output) => pushOutput(stream, output)), (stream) => finishTransform(stream, scheduler), () => ctx.close());
}
/**
 * Create a Node.js stream.Transform for zstd compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked compression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param level Compression level (1-22, or negative for fast mode). Default is 3.
 */
function createZstdCompressTransform(level) {
    return contextTransform(new index_js_1.ZstdCompressContext(level), 'zstd-compress', level, {
        setupMs: (0, stream_schedule_js_1.zstdSetupMs)(level),
    });
}
/**
 * Create a Node.js stream.Transform for zstd decompression.
 *
 * Uses Node.js `stream.Transform` to provide chunked decompression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 *
 * The transform emits an error if the input ends before the compressed stream
 * does, including empty input.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createZstdDecompressTransform(maxOutputSize) {
    return contextTransform(new index_js_1.ZstdDecompressContext(maxOutputSize), 'zstd-decompress', undefined);
}
/**
 * Create a Node.js stream.Transform for gzip compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked gzip compression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 * Produces spec-compliant gzip output with proper header and CRC32 footer.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param level Compression level (0-9). Default is 6.
 */
function createGzipCompressTransform(level) {
    return contextTransform(new index_js_1.GzipCompressContext(level), 'gzip-compress', level);
}
/**
 * Create a Node.js stream.Transform for gzip decompression.
 *
 * Uses Node.js `stream.Transform` to provide chunked gzip decompression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 * Verifies CRC32 integrity on finalization.
 *
 * The transform emits an error if the input ends before the compressed stream
 * does, including empty input.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createGzipDecompressTransform(maxOutputSize) {
    return contextTransform(new index_js_1.GzipDecompressContext(maxOutputSize), 'gzip-decompress', undefined);
}
/**
 * Create a Node.js stream.Transform for raw deflate compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked raw deflate compression
 * (no gzip header/footer) compatible with `stream.pipeline()` and pipe-based workflows.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param level Compression level (0-9). Default is 6.
 */
function createDeflateCompressTransform(level) {
    return contextTransform(new index_js_1.DeflateCompressContext(level), 'gzip-compress', level);
}
/**
 * Create a Node.js stream.Transform for raw deflate decompression.
 *
 * Uses Node.js `stream.Transform` to provide chunked raw deflate decompression
 * compatible with `stream.pipeline()` and pipe-based workflows.
 *
 * The transform emits an error if the input ends before the compressed stream
 * does, including empty input.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createDeflateDecompressTransform(maxOutputSize) {
    return contextTransform(new index_js_1.DeflateDecompressContext(maxOutputSize), 'gzip-decompress', undefined);
}
/**
 * Create a Node.js stream.Transform for brotli compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked brotli compression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param quality Compression quality (0-11). Default is 6.
 */
function createBrotliCompressTransform(quality) {
    return contextTransform(new index_js_1.BrotliCompressContext(quality), 'brotli-compress', quality);
}
/**
 * Create a Node.js stream.Transform for brotli decompression.
 *
 * Uses Node.js `stream.Transform` to provide chunked brotli decompression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 *
 * The transform emits an error if the input ends before the compressed stream
 * does, including empty input.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createBrotliDecompressTransform(maxOutputSize) {
    return contextTransform(new index_js_1.BrotliDecompressContext(maxOutputSize), 'brotli-decompress', undefined);
}
/**
 * Create a Node.js stream.Transform for zstd compression with a pre-trained dictionary.
 *
 * Uses Node.js `stream.Transform` to provide chunked compression with a pre-trained
 * dictionary, compatible with `stream.pipeline()` and pipe-based workflows.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param dict Pre-trained dictionary (from `zstdTrainDictionary`).
 * @param level Compression level (1-22, or negative for fast mode). Default is 3.
 */
function createZstdCompressDictTransform(dict, level) {
    return contextTransform(new index_js_1.ZstdCompressDictContext(dict, level), 'zstd-compress', level);
}
/**
 * Create a Node.js stream.Transform for zstd decompression with a pre-trained dictionary.
 *
 * Uses Node.js `stream.Transform` to provide chunked decompression with a pre-trained
 * dictionary, compatible with `stream.pipeline()` and pipe-based workflows.
 *
 * The transform emits an error if the input ends before the compressed stream
 * does, including empty input.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param dict Pre-trained dictionary (must match the one used for compression).
 */
function createZstdDecompressDictTransform(dict, maxOutputSize) {
    return contextTransform(new index_js_1.ZstdDecompressDictContext(dict, maxOutputSize), 'zstd-decompress', undefined);
}
/**
 * Create a Node.js stream.Transform for brotli compression with a custom dictionary.
 *
 * Uses Node.js `stream.Transform` to provide chunked compression with a custom
 * dictionary, compatible with `stream.pipeline()` and pipe-based workflows. It
 * holds up to the first 4 MiB less 16 bytes (4,194,288 bytes) of the input,
 * and compresses an input that ends there with the dictionary. A longer
 * input is compressed without the dictionary, which only helps the start of
 * a stream, and the Transform pushes compressed output as the input arrives.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param dict Custom dictionary bytes.
 * @param quality Compression quality (0-11). Default is 6.
 */
function createBrotliCompressDictTransform(dict, quality) {
    return contextTransform(new index_js_1.BrotliCompressDictContext(dict, quality, { incremental: true }), 'brotli-compress', quality, { holds: stream_schedule_js_1.BROTLI_DICT_REACH });
}
/**
 * Create a Node.js stream.Transform for brotli decompression with a custom dictionary.
 *
 * Uses Node.js `stream.Transform` to provide chunked decompression with a custom
 * dictionary, compatible with `stream.pipeline()` and pipe-based workflows.
 *
 * The transform emits an error if the input ends before the compressed stream
 * does, including empty input.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param dict Custom dictionary (must match the one used for compression).
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createBrotliDecompressDictTransform(dict, maxOutputSize) {
    return contextTransform(new index_js_1.BrotliDecompressDictContext(dict, maxOutputSize), 'brotli-decompress', undefined);
}
/**
 * A decompression context for `format`, and the scheduler that calls it.
 * Throws for a format that is unknown.
 */
function decompressScheduler(format, maxOutputSize) {
    let ctx;
    let op;
    switch (format) {
        case 'zstd':
            ctx = new index_js_1.ZstdDecompressContext(maxOutputSize);
            op = 'zstd-decompress';
            break;
        case 'gzip':
            ctx = new index_js_1.GzipDecompressContext(maxOutputSize);
            op = 'gzip-decompress';
            break;
        case 'brotli':
            ctx = new index_js_1.BrotliDecompressContext(maxOutputSize);
            op = 'brotli-decompress';
            break;
        case 'lz4':
            ctx = new index_js_1.Lz4DecompressContext(maxOutputSize, { incremental: true });
            op = 'lz4-decompress';
            break;
        default:
            throw new Error('unable to detect compression format from stream data');
    }
    return { ctx, scheduler: (0, stream_schedule_js_1.codecScheduler)(ctx, op, undefined) };
}
/**
 * How much input the auto-detecting transform waits for at most before it
 * decides on the format: detectFormat decodes up to the first 64 KiB to
 * recognize brotli.
 */
const DETECT_LIMIT = 64 * 1024;
/** The length of the zstd and LZ4 magic numbers, the longest ones. */
const MAGIC_LENGTH = 4;
/**
 * Create a Node.js stream.Transform for auto-detect decompression.
 *
 * Detects the compression format (zstd, gzip, brotli, or lz4) like
 * `detectFormat` and delegates to the appropriate decompression context.
 * Raw deflate is not supported (no magic bytes to distinguish it).
 *
 * The input is buffered until the format is detected: up to 64 KiB, or the
 * whole input if it is shorter, since brotli has no magic bytes and its
 * detection may need that much. The transform emits an error if the format
 * is still unknown then.
 *
 * The transform emits an error on empty input, which has no format to detect,
 * and on zstd, gzip or brotli input that ends before the compressed stream does.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createDecompressTransform(maxOutputSize) {
    let ctx = null;
    let scheduler = null;
    // The input received before the format is detected. Emptied once the
    // format is known, or the transform has closed, to release that memory.
    let buffered = [];
    let bufferedLength = 0;
    // Detection runs once this much input has arrived, then each time the
    // input doubles, so that small chunks do not make it run on every chunk.
    let detectAt = MAGIC_LENGTH;
    /**
     * Start decompressing `data` as `format`: return the scheduler, and the
     * step that transforms `data`.
     */
    function start(stream, format, data) {
        const started = decompressScheduler(format, maxOutputSize);
        ctx = started.ctx;
        scheduler = started.scheduler;
        buffered = [];
        const step = (0, stream_schedule_js_1.afterOutput)(started.scheduler.transform(data), (output) => pushOutput(stream, output));
        return [started.scheduler, step];
    }
    return closingTransform((stream, chunk) => {
        if (scheduler) {
            return (0, stream_schedule_js_1.afterOutput)(scheduler.transform(chunk), (output) => pushOutput(stream, output));
        }
        const copy = Buffer.from(chunk);
        buffered.push(copy);
        bufferedLength += copy.length;
        if (bufferedLength < detectAt) {
            return undefined;
        }
        const data = Buffer.concat(buffered, bufferedLength);
        const format = (0, index_js_1.detectFormat)(data);
        // More input may still reveal the format, as for the start of a
        // brotli stream or of a skippable frame.
        if (format === 'unknown' && bufferedLength < DETECT_LIMIT) {
            buffered = [data];
            detectAt = Math.min(2 * bufferedLength, DETECT_LIMIT);
            return undefined;
        }
        return start(stream, format, data)[1];
    }, (stream) => {
        if (scheduler) {
            return finishTransform(stream, scheduler);
        }
        // The input ended before its format was detected. Empty input has
        // no detectable format and throws.
        const data = Buffer.concat(buffered, bufferedLength);
        const [started, step] = start(stream, (0, index_js_1.detectFormat)(data), data);
        return step === undefined
            ? finishTransform(stream, started)
            : step.then(() => finishTransform(stream, started));
    }, () => {
        ctx?.close();
        buffered = [];
    });
}
/**
 * Create a Node.js stream.Transform for LZ4 frame compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked LZ4 compression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 */
function createLz4CompressTransform() {
    return contextTransform(new index_js_1.Lz4CompressContext(), 'lz4-compress', undefined);
}
/**
 * Create a Node.js stream.Transform for LZ4 frame decompression.
 *
 * Uses Node.js `stream.Transform` to provide chunked LZ4 decompression compatible
 * with `stream.pipeline()` and pipe-based workflows. It pushes the content of
 * each block as soon as all of the block has arrived, and holds at most one
 * block of the input.
 *
 * The input may hold several concatenated frames, including skippable and
 * legacy frames. The transform emits an error if the input ends inside a
 * frame, including empty input, or as soon as data that is not a frame
 * follows a frame.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default, 16 KiB on Windows).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createLz4DecompressTransform(maxOutputSize) {
    return contextTransform(new index_js_1.Lz4DecompressContext(maxOutputSize, { incremental: true }), 'lz4-decompress', undefined);
}
