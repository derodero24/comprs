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
/**
 * Largest result that the stream contexts return in memory that V8 owns. It
 * mirrors SYNC_COPY_LIMIT in crates/core/src/convert.rs, as VIEW_LIMIT in
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
    if (length === 0)
        return;
    const size = stream.readableHighWaterMark || 65536;
    if (length <= size) {
        stream.push(buf);
        return;
    }
    if (canMarkUntransferable && length <= COPY_LIMIT)
        (0, node_worker_threads_1.markAsUntransferable)(buf.buffer);
    for (let i = 0; i < length; i += size) {
        stream.push(buf.subarray(i, i + size));
        if (buf.byteLength !== length) {
            throw new Error('an output chunk was transferred, which detached the other chunks of the same result; copy a chunk with new Uint8Array(chunk) before transferring it');
        }
    }
}
/**
 * Create a Transform from `transform` and `flush`, which call stream
 * contexts. `close` closes the contexts once the stream is destroyed, which
 * happens when it ends, fails or is destroyed early, and releases their
 * native memory right away instead of when the garbage collector gets to
 * them.
 */
function closingTransform(transform, flush, close) {
    return new node_stream_1.Transform({
        // Without objectMode, every chunk written is a Buffer.
        transform(chunk, _encoding, callback) {
            try {
                transform(this, chunk);
                callback();
            }
            catch (err) {
                // Pass on what was thrown as it is. Under Jest, which runs this
                // module in a vm context, the errors of the native addon are not
                // instances of that context's Error, and wrapping them would drop
                // their code.
                callback(err);
            }
        },
        flush(callback) {
            try {
                flush(this);
                callback();
            }
            catch (err) {
                callback(err);
            }
        },
        destroy(err, callback) {
            close();
            callback(err);
        },
    });
}
/** Create a Transform that feeds its input through `ctx`. */
function contextTransform(ctx) {
    return closingTransform((stream, chunk) => pushSliced(stream, ctx.transform(chunk)), (stream) => {
        pushSliced(stream, ctx.flush());
        pushSliced(stream, ctx.finish());
    }, () => ctx.close());
}
/**
 * Create a Node.js stream.Transform for zstd compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked compression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default).
 *
 * @param level Compression level (1-22, or negative for fast mode). Default is 3.
 */
function createZstdCompressTransform(level) {
    return contextTransform(new index_js_1.ZstdCompressContext(level));
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
 * default).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createZstdDecompressTransform(maxOutputSize) {
    return contextTransform(new index_js_1.ZstdDecompressContext(maxOutputSize));
}
/**
 * Create a Node.js stream.Transform for gzip compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked gzip compression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 * Produces spec-compliant gzip output with proper header and CRC32 footer.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default).
 *
 * @param level Compression level (0-9). Default is 6.
 */
function createGzipCompressTransform(level) {
    return contextTransform(new index_js_1.GzipCompressContext(level));
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
 * default).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createGzipDecompressTransform(maxOutputSize) {
    return contextTransform(new index_js_1.GzipDecompressContext(maxOutputSize));
}
/**
 * Create a Node.js stream.Transform for raw deflate compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked raw deflate compression
 * (no gzip header/footer) compatible with `stream.pipeline()` and pipe-based workflows.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default).
 *
 * @param level Compression level (0-9). Default is 6.
 */
function createDeflateCompressTransform(level) {
    return contextTransform(new index_js_1.DeflateCompressContext(level));
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
 * default).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createDeflateDecompressTransform(maxOutputSize) {
    return contextTransform(new index_js_1.DeflateDecompressContext(maxOutputSize));
}
/**
 * Create a Node.js stream.Transform for brotli compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked brotli compression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default).
 *
 * @param quality Compression quality (0-11). Default is 6.
 */
function createBrotliCompressTransform(quality) {
    return contextTransform(new index_js_1.BrotliCompressContext(quality));
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
 * default).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createBrotliDecompressTransform(maxOutputSize) {
    return contextTransform(new index_js_1.BrotliDecompressContext(maxOutputSize));
}
/**
 * Create a Node.js stream.Transform for zstd compression with a pre-trained dictionary.
 *
 * Uses Node.js `stream.Transform` to provide chunked compression with a pre-trained
 * dictionary, compatible with `stream.pipeline()` and pipe-based workflows.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default).
 *
 * @param dict Pre-trained dictionary (from `zstdTrainDictionary`).
 * @param level Compression level (1-22, or negative for fast mode). Default is 3.
 */
function createZstdCompressDictTransform(dict, level) {
    return contextTransform(new index_js_1.ZstdCompressDictContext(dict, level));
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
 * default).
 *
 * @param dict Pre-trained dictionary (must match the one used for compression).
 */
function createZstdDecompressDictTransform(dict, maxOutputSize) {
    return contextTransform(new index_js_1.ZstdDecompressDictContext(dict, maxOutputSize));
}
/**
 * Create a Node.js stream.Transform for brotli compression with a custom dictionary.
 *
 * Uses Node.js `stream.Transform` to provide chunked compression with a custom
 * dictionary, compatible with `stream.pipeline()` and pipe-based workflows.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default).
 *
 * @param dict Custom dictionary bytes.
 * @param quality Compression quality (0-11). Default is 6.
 */
function createBrotliCompressDictTransform(dict, quality) {
    return contextTransform(new index_js_1.BrotliCompressDictContext(dict, quality));
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
 * default).
 *
 * @param dict Custom dictionary (must match the one used for compression).
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createBrotliDecompressDictTransform(dict, maxOutputSize) {
    return contextTransform(new index_js_1.BrotliDecompressDictContext(dict, maxOutputSize));
}
function createDecompressContext(format, maxOutputSize) {
    switch (format) {
        case 'zstd':
            return new index_js_1.ZstdDecompressContext(maxOutputSize);
        case 'gzip':
            return new index_js_1.GzipDecompressContext(maxOutputSize);
        case 'brotli':
            return new index_js_1.BrotliDecompressContext(maxOutputSize);
        case 'lz4':
            return new index_js_1.Lz4DecompressContext(maxOutputSize);
        default:
            throw new Error('unable to detect compression format from stream data');
    }
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
 * default).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createDecompressTransform(maxOutputSize) {
    let ctx = null;
    // The input received before the format is detected. Emptied once the
    // format is known, or the transform has closed, to release that memory.
    let buffered = [];
    let bufferedLength = 0;
    // Detection runs once this much input has arrived, then each time the
    // input doubles, so that small chunks do not make it run on every chunk.
    let detectAt = MAGIC_LENGTH;
    function start(stream, format, data) {
        const context = createDecompressContext(format, maxOutputSize);
        ctx = context;
        buffered = [];
        pushSliced(stream, context.transform(data));
        return context;
    }
    return closingTransform((stream, chunk) => {
        if (ctx) {
            pushSliced(stream, ctx.transform(chunk));
            return;
        }
        const copy = Buffer.from(chunk);
        buffered.push(copy);
        bufferedLength += copy.length;
        if (bufferedLength < detectAt)
            return;
        const data = Buffer.concat(buffered, bufferedLength);
        const format = (0, index_js_1.detectFormat)(data);
        // More input may still reveal the format, as for the start of a
        // brotli stream or of a skippable frame.
        if (format === 'unknown' && bufferedLength < DETECT_LIMIT) {
            buffered = [data];
            detectAt = Math.min(2 * bufferedLength, DETECT_LIMIT);
            return;
        }
        start(stream, format, data);
    }, (stream) => {
        let context = ctx;
        if (!context) {
            // The input ended before its format was detected. Empty input has
            // no detectable format and throws.
            const data = Buffer.concat(buffered, bufferedLength);
            context = start(stream, (0, index_js_1.detectFormat)(data), data);
        }
        pushSliced(stream, context.flush());
        // finish() verifies that the input contained the whole stream.
        pushSliced(stream, context.finish());
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
 * default).
 */
function createLz4CompressTransform() {
    return contextTransform(new index_js_1.Lz4CompressContext());
}
/**
 * Create a Node.js stream.Transform for LZ4 frame decompression.
 *
 * Uses Node.js `stream.Transform` to provide chunked LZ4 decompression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 *
 * The input may hold several concatenated frames, including skippable and
 * legacy frames. The transform emits an error if the input ends inside a
 * frame, including empty input, or if data that is not a frame follows a
 * frame.
 *
 * Output chunks hold at most `readableHighWaterMark` bytes (64 KiB by
 * default).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createLz4DecompressTransform(maxOutputSize) {
    return contextTransform(new index_js_1.Lz4DecompressContext(maxOutputSize));
}
