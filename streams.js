"use strict";
exports.createBrotliCompressStream = createBrotliCompressStream;
exports.createBrotliDecompressStream = createBrotliDecompressStream;
exports.createZstdCompressStream = createZstdCompressStream;
exports.createZstdDecompressStream = createZstdDecompressStream;
exports.createGzipCompressStream = createGzipCompressStream;
exports.createGzipDecompressStream = createGzipDecompressStream;
exports.createDeflateCompressStream = createDeflateCompressStream;
exports.createDeflateDecompressStream = createDeflateDecompressStream;
exports.createBrotliCompressDictStream = createBrotliCompressDictStream;
exports.createBrotliDecompressDictStream = createBrotliDecompressDictStream;
exports.createZstdCompressDictStream = createZstdCompressDictStream;
exports.createZstdDecompressDictStream = createZstdDecompressDictStream;
exports.createLz4CompressStream = createLz4CompressStream;
exports.createLz4DecompressStream = createLz4DecompressStream;
exports.createDecompressStream = createDecompressStream;
const node_util_1 = require("node:util");
const index_js_1 = require("./index.js");
/**
 * View `chunk`, a chunk written to a stream, as bytes. The streams accept
 * what `CompressionStream` accepts, any ArrayBuffer or ArrayBufferView, as
 * well as a SharedArrayBuffer, and read it byte for byte: a typed array is
 * not converted element by element.
 */
function toUint8Array(chunk) {
    if (chunk instanceof Uint8Array)
        return chunk;
    if (ArrayBuffer.isView(chunk)) {
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    // Unlike instanceof, this also recognizes an ArrayBuffer or a
    // SharedArrayBuffer from another realm, such as a vm context.
    if (node_util_1.types.isAnyArrayBuffer(chunk))
        return new Uint8Array(chunk);
    throw new TypeError('chunk must be an ArrayBuffer or ArrayBufferView');
}
function enqueueIfNonEmpty(controller, result) {
    if (result.byteLength > 0) {
        controller.enqueue(new Uint8Array(result));
    }
}
/**
 * Create a TransformStream from `transform` and `flush`, which call stream
 * contexts. `transform` receives each input chunk as a Uint8Array, and a
 * chunk that is not an ArrayBuffer or ArrayBufferView errors the stream.
 * `close` closes the contexts once the stream ends, fails or is cancelled,
 * which releases their native memory right away instead of when the garbage
 * collector gets to them.
 */
function closingStream(transform, flush, close) {
    return new TransformStream({
        transform(chunk, controller) {
            try {
                transform(toUint8Array(chunk), controller);
            }
            catch (err) {
                close();
                throw err;
            }
        },
        flush(controller) {
            try {
                flush(controller);
            }
            finally {
                close();
            }
        },
        cancel() {
            close();
        },
    });
}
/** Create a TransformStream that feeds its input through `ctx`. */
function contextStream(ctx) {
    return closingStream((chunk, controller) => enqueueIfNonEmpty(controller, ctx.transform(chunk)), (controller) => {
        enqueueIfNonEmpty(controller, ctx.flush());
        enqueueIfNonEmpty(controller, ctx.finish());
    }, () => ctx.close());
}
/**
 * Create a streaming brotli compression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked compression.
 * Data compressed across multiple chunks maintains cross-chunk context for
 * optimal compression ratio.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param quality Compression quality (0-11). Default is 6.
 */
function createBrotliCompressStream(quality) {
    return contextStream(new index_js_1.BrotliCompressContext(quality));
}
/**
 * Create a streaming brotli decompression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked decompression.
 *
 * The stream errors if the input ends before the compressed stream does,
 * including empty input.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createBrotliDecompressStream(maxOutputSize) {
    return contextStream(new index_js_1.BrotliDecompressContext(maxOutputSize));
}
/**
 * Create a streaming zstd compression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked compression.
 * Data compressed across multiple chunks maintains cross-chunk context for
 * optimal compression ratio.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param level Compression level (1-22, or negative for fast mode). Default is 3.
 */
function createZstdCompressStream(level) {
    return contextStream(new index_js_1.ZstdCompressContext(level));
}
/**
 * Create a streaming zstd decompression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked decompression.
 *
 * The stream errors if the input ends before the compressed stream does,
 * including empty input.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createZstdDecompressStream(maxOutputSize) {
    return contextStream(new index_js_1.ZstdDecompressContext(maxOutputSize));
}
/**
 * Create a streaming gzip compression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked gzip compression.
 * Produces spec-compliant gzip output with proper header and CRC32 footer.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param level Compression level (0-9). Default is 6.
 */
function createGzipCompressStream(level) {
    return contextStream(new index_js_1.GzipCompressContext(level));
}
/**
 * Create a streaming gzip decompression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked gzip decompression.
 * Verifies CRC32 integrity on finalization.
 *
 * The stream errors if the input ends before the compressed stream does,
 * including empty input.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createGzipDecompressStream(maxOutputSize) {
    return contextStream(new index_js_1.GzipDecompressContext(maxOutputSize));
}
/**
 * Create a streaming raw deflate compression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked raw deflate
 * compression (no gzip header/footer).
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param level Compression level (0-9). Default is 6.
 */
function createDeflateCompressStream(level) {
    return contextStream(new index_js_1.DeflateCompressContext(level));
}
/**
 * Create a streaming raw deflate decompression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked raw deflate
 * decompression.
 *
 * The stream errors if the input ends before the compressed stream does,
 * including empty input.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createDeflateDecompressStream(maxOutputSize) {
    return contextStream(new index_js_1.DeflateDecompressContext(maxOutputSize));
}
/**
 * Create a streaming brotli compression TransformStream with a custom dictionary.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked compression
 * with a custom dictionary for improved compression of similar data.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param dict Custom dictionary bytes.
 * @param quality Compression quality (0-11). Default is 6.
 */
function createBrotliCompressDictStream(dict, quality) {
    return contextStream(new index_js_1.BrotliCompressDictContext(dict, quality));
}
/**
 * Create a streaming brotli decompression TransformStream with a custom dictionary.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked decompression
 * with a custom dictionary. The same dictionary used for compression must be provided.
 *
 * The stream errors if the input ends before the compressed stream does,
 * including empty input.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param dict Custom dictionary (must match the one used for compression).
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createBrotliDecompressDictStream(dict, maxOutputSize) {
    return contextStream(new index_js_1.BrotliDecompressDictContext(dict, maxOutputSize));
}
/**
 * Create a streaming zstd compression TransformStream with a pre-trained dictionary.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked compression
 * with a pre-trained dictionary for improved compression of small, similar data.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param dict Pre-trained dictionary (from `zstdTrainDictionary`).
 * @param level Compression level (1-22, or negative for fast mode). Default is 3.
 */
function createZstdCompressDictStream(dict, level) {
    return contextStream(new index_js_1.ZstdCompressDictContext(dict, level));
}
/**
 * Create a streaming zstd decompression TransformStream with a pre-trained dictionary.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked decompression
 * with a pre-trained dictionary. The same dictionary used for compression must be provided.
 *
 * The stream errors if the input ends before the compressed stream does,
 * including empty input.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param dict Pre-trained dictionary (must match the one used for compression).
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createZstdDecompressDictStream(dict, maxOutputSize) {
    return contextStream(new index_js_1.ZstdDecompressDictContext(dict, maxOutputSize));
}
/**
 * Create a streaming LZ4 frame compression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked LZ4 compression.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 */
function createLz4CompressStream() {
    return contextStream(new index_js_1.Lz4CompressContext());
}
/**
 * Create a streaming LZ4 frame decompression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked LZ4 decompression.
 *
 * The input may hold several concatenated frames, including skippable and
 * legacy frames. The stream errors if the input ends inside a frame,
 * including empty input, or if data that is not a frame follows a frame.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createLz4DecompressStream(maxOutputSize) {
    return contextStream(new index_js_1.Lz4DecompressContext(maxOutputSize));
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
 * How much input the auto-detecting stream waits for at most before it
 * decides on the format: detectFormat decodes up to the first 64 KiB to
 * recognize brotli.
 */
const DETECT_LIMIT = 64 * 1024;
/** The length of the zstd and LZ4 magic numbers, the longest ones. */
const MAGIC_LENGTH = 4;
/** Concatenate `chunks`, whose lengths add up to `length`. */
function concatChunks(chunks, length) {
    if (chunks.length === 1 && chunks[0] !== undefined)
        return chunks[0];
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return data;
}
/**
 * Create a streaming auto-detect decompression TransformStream.
 *
 * Detects the compression format (zstd, gzip, brotli, or lz4) like
 * `detectFormat` and delegates to the appropriate decompression context.
 * Raw deflate is not supported (no magic bytes to distinguish it).
 *
 * The input is buffered until the format is detected: up to 64 KiB, or the
 * whole input if it is shorter, since brotli has no magic bytes and its
 * detection may need that much. The stream errors if the format is still
 * unknown then.
 *
 * The stream errors on empty input, which has no format to detect, and on
 * zstd, gzip or brotli input that ends before the compressed stream does.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createDecompressStream(maxOutputSize) {
    let ctx = null;
    // The input received before the format is detected. Emptied once the
    // format is known, or the stream has closed, to release that memory.
    let buffered = [];
    let bufferedLength = 0;
    // Detection runs once this much input has arrived, then each time the
    // input doubles, so that small chunks do not make it run on every chunk.
    let detectAt = MAGIC_LENGTH;
    function start(format, data, controller) {
        const context = createDecompressContext(format, maxOutputSize);
        ctx = context;
        buffered = [];
        enqueueIfNonEmpty(controller, context.transform(data));
        return context;
    }
    return closingStream((chunk, controller) => {
        if (ctx) {
            enqueueIfNonEmpty(controller, ctx.transform(chunk));
            return;
        }
        // Copy the chunk: the writer may reuse its memory once this returns.
        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        buffered.push(copy);
        bufferedLength += copy.byteLength;
        if (bufferedLength < detectAt)
            return;
        const data = concatChunks(buffered, bufferedLength);
        const format = (0, index_js_1.detectFormat)(data);
        // More input may still reveal the format, as for the start of a
        // brotli stream or of a skippable frame.
        if (format === 'unknown' && bufferedLength < DETECT_LIMIT) {
            buffered = [data];
            detectAt = Math.min(2 * bufferedLength, DETECT_LIMIT);
            return;
        }
        start(format, data, controller);
    }, (controller) => {
        let context = ctx;
        if (!context) {
            // The input ended before its format was detected. Empty input has no
            // detectable format and throws.
            const data = concatChunks(buffered, bufferedLength);
            context = start((0, index_js_1.detectFormat)(data), data, controller);
        }
        enqueueIfNonEmpty(controller, context.flush());
        // finish() verifies that the input contained the whole stream.
        enqueueIfNonEmpty(controller, context.finish());
    }, () => {
        ctx?.close();
        buffered = [];
    });
}
