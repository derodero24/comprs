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
const stream_schedule_js_1 = require("./stream-schedule.js");
/** The getter of `key` on `prototype`, a built-in prototype. */
function getterOf(prototype, key) {
    return prototype ? Object.getOwnPropertyDescriptor(prototype, key)?.get : undefined;
}
/** `getter`, called on `value`. A getter that the runtime lacks throws. */
function callGetter(getter, value) {
    if (getter === undefined)
        throw new TypeError('the runtime lacks a getter of a built-in');
    return Reflect.apply(getter, value, []);
}
function viewGetters(prototype) {
    return {
        buffer: getterOf(prototype, 'buffer'),
        byteOffset: getterOf(prototype, 'byteOffset'),
        byteLength: getterOf(prototype, 'byteLength'),
    };
}
/** %TypedArray%.prototype, which every typed array inherits from. */
const TYPED_ARRAY_PROTOTYPE = Reflect.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_GETTERS = viewGetters(TYPED_ARRAY_PROTOTYPE);
const DATA_VIEW_GETTERS = viewGetters(DataView.prototype);
/**
 * The getter of the name of the type of a typed array, which returns
 * `undefined` for any other value, a DataView included.
 */
const TYPED_ARRAY_NAME = getterOf(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag);
/**
 * `view` as a new Uint8Array over the bytes that it holds. Its buffer and
 * its bounds are read with the getters of built-in prototypes, which read
 * the internal slots of the view, as the native addon and the WebAssembly
 * build do: a subclass or an own property of the view can make its
 * `byteLength`, `byteOffset` or `buffer` property disagree with them
 * (#711). A view whose buffer is detached, or out of the bounds of a
 * resizable buffer that shrank, holds no bytes, as the functions of the
 * package root read it: the getters of a typed array then return 0, and
 * those of a DataView throw.
 */
function viewBytes(view) {
    const getters = callGetter(TYPED_ARRAY_NAME, view) === undefined ? DATA_VIEW_GETTERS : TYPED_ARRAY_GETTERS;
    try {
        const buffer = callGetter(getters.buffer, view);
        const byteOffset = callGetter(getters.byteOffset, view);
        const byteLength = callGetter(getters.byteLength, view);
        if (node_util_1.types.isAnyArrayBuffer(buffer) &&
            typeof byteOffset === 'number' &&
            typeof byteLength === 'number') {
            return new Uint8Array(buffer, byteOffset, byteLength);
        }
    }
    catch {
        // A DataView whose buffer is detached or shrank, or a typed array whose
        // buffer is detached, for which new Uint8Array() throws.
    }
    return new Uint8Array(0);
}
/**
 * View `chunk`, a chunk written to a stream, as bytes. The streams accept
 * what `CompressionStream` accepts, any ArrayBuffer or ArrayBufferView, as
 * well as a SharedArrayBuffer, and read it byte for byte: a typed array is
 * not converted element by element. A view becomes a new Uint8Array over its
 * bytes (see viewBytes), whose properties the stream may then trust, as it
 * does when it buffers a copy of the chunk.
 */
function toUint8Array(chunk) {
    if (ArrayBuffer.isView(chunk))
        return viewBytes(chunk);
    // Unlike instanceof, this also recognizes an ArrayBuffer or a
    // SharedArrayBuffer from another realm, such as a vm context.
    if (node_util_1.types.isAnyArrayBuffer(chunk))
        return new Uint8Array(chunk);
    throw new TypeError('chunk must be an ArrayBuffer or ArrayBufferView');
}
/**
 * Largest result of a stream context that the streams enqueue without
 * copying it. It mirrors SYNC_COPY_LIMIT and ASYNC_STREAM_COPY_LIMIT in
 * crates/core/src/convert.rs, the smaller of them should they differ: the
 * contexts return results up to that size in memory that V8 allocates, from
 * their synchronous and their asynchronous methods, and larger ones in memory
 * of the addon, which Node.js marks as untransferable.
 */
const VIEW_LIMIT = 2 * 1024 * 1024;
/**
 * The chunk that the streams enqueue for `result`, which a stream context
 * returned.
 *
 * The streams emit plain Uint8Array chunks, not Buffers, whose slice()
 * differs. A result in memory that V8 allocated, with an ArrayBuffer of its
 * own, is enqueued as a view of that memory, which a reader can transfer to
 * a worker. Any other result is copied: Node.js marks the memory of the
 * addon as untransferable, so a view of it could not be transferred there
 * (DataCloneError), and on a runtime whose napi_create_buffer_copy()
 * allocates from a pool, transferring a shared ArrayBuffer would detach
 * other chunks too.
 */
function outputChunk(result) {
    const ownsBuffer = result.byteLength <= VIEW_LIMIT &&
        result.byteOffset === 0 &&
        result.buffer.byteLength === result.byteLength;
    return ownsBuffer
        ? new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
        : new Uint8Array(result);
}
/**
 * Create a TransformStream from `transform` and `flush`, which call stream
 * contexts and pass their results to `emit`, at once or once a call on the
 * thread pool settles. `transform` receives each input chunk as a
 * Uint8Array, and a chunk that is not an ArrayBuffer or ArrayBufferView
 * errors the stream. `close` closes the contexts once the stream ends, fails
 * or is cancelled, which releases their native memory right away instead of
 * when the garbage collector gets to them.
 *
 * A call may still be in flight when the stream is cancelled: its context
 * releases the memory once the call settles, and its result is dropped. The
 * stream waits for the Promise that `transform` or `flush` returns before it
 * calls either again, and handles its rejection even after a cancel, so a
 * call that fails late is never an unhandled rejection, which would crash
 * Node.js by default.
 */
function closingStream(transform, flush, close) {
    // Whether the readable side takes no more chunks.
    let cancelled = false;
    function emitter(controller) {
        return (result) => {
            if (cancelled || result.byteLength === 0)
                return;
            const chunk = outputChunk(result);
            try {
                controller.enqueue(chunk);
            }
            catch {
                // A reader cancelled the readable side while flush() waited for a
                // call on the thread pool. The stream then waits for flush()
                // instead of calling cancel(), and enqueue() throws, which would
                // fail the cancel with that error: the output is dropped instead,
                // as after cancel().
                cancelled = true;
            }
        };
    }
    return new TransformStream({
        transform(chunk, controller) {
            let step;
            try {
                step = transform(toUint8Array(chunk), emitter(controller));
            }
            catch (err) {
                close();
                throw err;
            }
            return step?.catch((err) => {
                close();
                throw err;
            });
        },
        flush(controller) {
            let step;
            try {
                step = flush(emitter(controller));
            }
            catch (err) {
                close();
                throw err;
            }
            if (step === undefined) {
                close();
                return undefined;
            }
            return step.finally(close);
        },
        cancel() {
            cancelled = true;
            close();
        },
    });
}
/**
 * Pass the output of `flush()` and then of `finish()` of `scheduler` to
 * `emit`. finish() ends the stream, and fails if the input of a
 * decompression stream did not hold the whole compressed stream.
 */
function finishStream(scheduler, emit) {
    return (0, stream_schedule_js_1.afterOutput)(scheduler.flush(), (flushed) => {
        emit(flushed);
        return (0, stream_schedule_js_1.afterOutput)(scheduler.finish(), emit);
    });
}
/**
 * Create a TransformStream that feeds its input through `ctx`, a stream
 * context of `op` at `level`, which processes it as `model` adds (see
 * codecScheduler).
 */
function contextStream(ctx, op, level, model) {
    const scheduler = (0, stream_schedule_js_1.codecScheduler)(ctx, op, level, model);
    return closingStream((chunk, emit) => (0, stream_schedule_js_1.afterOutput)(scheduler.transform(chunk), emit), (emit) => finishStream(scheduler, emit), () => ctx.close());
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
    return contextStream(new index_js_1.BrotliCompressContext(quality), 'brotli-compress', quality);
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
    return contextStream(new index_js_1.BrotliDecompressContext(maxOutputSize), 'brotli-decompress', undefined);
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
    return contextStream(new index_js_1.ZstdCompressContext(level), 'zstd-compress', level, {
        setupMs: (0, stream_schedule_js_1.zstdSetupMs)(level),
    });
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
    return contextStream(new index_js_1.ZstdDecompressContext(maxOutputSize), 'zstd-decompress', undefined);
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
    return contextStream(new index_js_1.GzipCompressContext(level), 'gzip-compress', level);
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
    return contextStream(new index_js_1.GzipDecompressContext(maxOutputSize), 'gzip-decompress', undefined);
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
    return contextStream(new index_js_1.DeflateCompressContext(level), 'gzip-compress', level);
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
    return contextStream(new index_js_1.DeflateDecompressContext(maxOutputSize), 'gzip-decompress', undefined);
}
/**
 * Create a streaming brotli compression TransformStream with a custom dictionary.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked compression
 * with a custom dictionary for improved compression of similar data. It
 * holds up to the first 4 MiB less 16 bytes (4,194,288 bytes) of the input,
 * and compresses an input that ends there with the dictionary. A longer
 * input is compressed without the dictionary, which only helps the start of
 * a stream, and the stream emits compressed output as the input arrives.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param dict Custom dictionary bytes.
 * @param quality Compression quality (0-11). Default is 6.
 */
function createBrotliCompressDictStream(dict, quality) {
    return contextStream(new index_js_1.BrotliCompressDictContext(dict, quality, { incremental: true }), 'brotli-compress', quality, { holds: stream_schedule_js_1.BROTLI_DICT_REACH });
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
    return contextStream(new index_js_1.BrotliDecompressDictContext(dict, maxOutputSize), 'brotli-decompress', undefined);
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
    return contextStream(new index_js_1.ZstdCompressDictContext(dict, level), 'zstd-compress', level);
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
    return contextStream(new index_js_1.ZstdDecompressDictContext(dict, maxOutputSize), 'zstd-decompress', undefined);
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
    return contextStream(new index_js_1.Lz4CompressContext(), 'lz4-compress', undefined);
}
/**
 * Create a streaming LZ4 frame decompression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked LZ4 decompression.
 * It emits the content of each block as soon as all of the block has
 * arrived, and holds at most one block of the input.
 *
 * The input may hold several concatenated frames, including skippable and
 * legacy frames. The stream errors if the input ends inside a frame,
 * including empty input, or as soon as data that is not a frame follows a
 * frame.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
function createLz4DecompressStream(maxOutputSize) {
    return contextStream(new index_js_1.Lz4DecompressContext(maxOutputSize, { incremental: true }), 'lz4-decompress', undefined);
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
    let scheduler = null;
    // The input received before the format is detected. Emptied once the
    // format is known, or the stream has closed, to release that memory.
    let buffered = [];
    let bufferedLength = 0;
    // Detection runs once this much input has arrived, then each time the
    // input doubles, so that small chunks do not make it run on every chunk.
    let detectAt = MAGIC_LENGTH;
    /**
     * Start decompressing `data` as `format`: return the scheduler, and the
     * step that transforms `data`.
     */
    function start(format, data, emit) {
        const started = decompressScheduler(format, maxOutputSize);
        ctx = started.ctx;
        scheduler = started.scheduler;
        buffered = [];
        return [started.scheduler, (0, stream_schedule_js_1.afterOutput)(started.scheduler.transform(data), emit)];
    }
    return closingStream((chunk, emit) => {
        if (scheduler)
            return (0, stream_schedule_js_1.afterOutput)(scheduler.transform(chunk), emit);
        // Copy the chunk: the writer may reuse its memory once this returns.
        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        buffered.push(copy);
        bufferedLength += copy.byteLength;
        if (bufferedLength < detectAt)
            return undefined;
        const data = concatChunks(buffered, bufferedLength);
        const format = (0, index_js_1.detectFormat)(data);
        // More input may still reveal the format, as for the start of a
        // brotli stream or of a skippable frame.
        if (format === 'unknown' && bufferedLength < DETECT_LIMIT) {
            buffered = [data];
            detectAt = Math.min(2 * bufferedLength, DETECT_LIMIT);
            return undefined;
        }
        return start(format, data, emit)[1];
    }, (emit) => {
        if (scheduler)
            return finishStream(scheduler, emit);
        // The input ended before its format was detected. Empty input has no
        // detectable format and throws.
        const data = concatChunks(buffered, bufferedLength);
        const [started, step] = start((0, index_js_1.detectFormat)(data), data, emit);
        return step === undefined
            ? finishStream(started, emit)
            : step.then(() => finishStream(started, emit));
    }, () => {
        ctx?.close();
        buffered = [];
    });
}
