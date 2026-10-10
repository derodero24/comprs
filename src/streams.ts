import { types } from 'node:util';
import {
  BrotliCompressContext,
  BrotliCompressDictContext,
  BrotliDecompressContext,
  BrotliDecompressDictContext,
  type CompressionFormat,
  DeflateCompressContext,
  DeflateDecompressContext,
  detectFormat,
  GzipCompressContext,
  GzipDecompressContext,
  Lz4CompressContext,
  Lz4DecompressContext,
  ZstdCompressContext,
  ZstdCompressDictContext,
  ZstdDecompressContext,
  ZstdDecompressDictContext,
} from './index.js';

/** The methods of the stream contexts that the streams call. */
interface StreamContext {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  finish(): Uint8Array;
  close(): void;
}

/** The controller of the streams, which emit Uint8Array chunks. */
type Controller = TransformStreamDefaultController<Uint8Array>;

/**
 * View `chunk`, a chunk written to a stream, as bytes. The streams accept
 * what `CompressionStream` accepts, any ArrayBuffer or ArrayBufferView, as
 * well as a SharedArrayBuffer, and read it byte for byte: a typed array is
 * not converted element by element.
 */
function toUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  // Unlike instanceof, this also recognizes an ArrayBuffer or a
  // SharedArrayBuffer from another realm, such as a vm context.
  if (types.isAnyArrayBuffer(chunk)) return new Uint8Array(chunk);
  throw new TypeError('chunk must be an ArrayBuffer or ArrayBufferView');
}

/**
 * Largest result of a stream context that the streams enqueue without
 * copying it. It mirrors SYNC_COPY_LIMIT in crates/core/src/convert.rs: the
 * contexts return results up to that size in memory that V8 allocates, and
 * larger ones in memory of the addon, which Node.js marks as untransferable.
 */
const VIEW_LIMIT = 2 * 1024 * 1024;

/**
 * Enqueue `result`, which a stream context returned, unless it is empty.
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
function enqueueIfNonEmpty(controller: Controller, result: Uint8Array): void {
  if (result.byteLength === 0) return;
  const ownsBuffer =
    result.byteLength <= VIEW_LIMIT &&
    result.byteOffset === 0 &&
    result.buffer.byteLength === result.byteLength;
  controller.enqueue(
    ownsBuffer
      ? new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
      : new Uint8Array(result),
  );
}

/**
 * Create a TransformStream from `transform` and `flush`, which call stream
 * contexts. `transform` receives each input chunk as a Uint8Array, and a
 * chunk that is not an ArrayBuffer or ArrayBufferView errors the stream.
 * `close` closes the contexts once the stream ends, fails or is cancelled,
 * which releases their native memory right away instead of when the garbage
 * collector gets to them.
 */
function closingStream(
  transform: (chunk: Uint8Array, controller: Controller) => void,
  flush: (controller: Controller) => void,
  close: () => void,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return new TransformStream({
    transform(chunk: ArrayBufferLike | ArrayBufferView, controller: Controller): void {
      try {
        transform(toUint8Array(chunk), controller);
      } catch (err) {
        close();
        throw err;
      }
    },
    flush(controller: Controller): void {
      try {
        flush(controller);
      } finally {
        close();
      }
    },
    cancel(): void {
      close();
    },
  });
}

/** Create a TransformStream that feeds its input through `ctx`. */
function contextStream(
  ctx: StreamContext,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return closingStream(
    (chunk, controller) => enqueueIfNonEmpty(controller, ctx.transform(chunk)),
    (controller) => {
      enqueueIfNonEmpty(controller, ctx.flush());
      enqueueIfNonEmpty(controller, ctx.finish());
    },
    () => ctx.close(),
  );
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
export function createBrotliCompressStream(
  quality?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new BrotliCompressContext(quality));
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
export function createBrotliDecompressStream(
  maxOutputSize?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new BrotliDecompressContext(maxOutputSize));
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
export function createZstdCompressStream(
  level?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new ZstdCompressContext(level));
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
export function createZstdDecompressStream(
  maxOutputSize?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new ZstdDecompressContext(maxOutputSize));
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
export function createGzipCompressStream(
  level?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new GzipCompressContext(level));
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
export function createGzipDecompressStream(
  maxOutputSize?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new GzipDecompressContext(maxOutputSize));
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
export function createDeflateCompressStream(
  level?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new DeflateCompressContext(level));
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
export function createDeflateDecompressStream(
  maxOutputSize?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new DeflateDecompressContext(maxOutputSize));
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
export function createBrotliCompressDictStream(
  dict: Buffer | Uint8Array,
  quality?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new BrotliCompressDictContext(dict, quality));
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
export function createBrotliDecompressDictStream(
  dict: Buffer | Uint8Array,
  maxOutputSize?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new BrotliDecompressDictContext(dict, maxOutputSize));
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
export function createZstdCompressDictStream(
  dict: Buffer | Uint8Array,
  level?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new ZstdCompressDictContext(dict, level));
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
export function createZstdDecompressDictStream(
  dict: Buffer | Uint8Array,
  maxOutputSize?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new ZstdDecompressDictContext(dict, maxOutputSize));
}

/**
 * Create a streaming LZ4 frame compression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked LZ4 compression.
 *
 * Input chunks may be any ArrayBuffer, SharedArrayBuffer or ArrayBufferView,
 * read byte for byte: a `Uint16Array` is not converted element by element.
 */
export function createLz4CompressStream(): TransformStream<
  ArrayBufferLike | ArrayBufferView,
  Uint8Array
> {
  return contextStream(new Lz4CompressContext());
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
export function createLz4DecompressStream(
  maxOutputSize?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return contextStream(new Lz4DecompressContext(maxOutputSize));
}

function createDecompressContext(
  format: CompressionFormat,
  maxOutputSize: number | undefined,
): StreamContext {
  switch (format) {
    case 'zstd':
      return new ZstdDecompressContext(maxOutputSize);
    case 'gzip':
      return new GzipDecompressContext(maxOutputSize);
    case 'brotli':
      return new BrotliDecompressContext(maxOutputSize);
    case 'lz4':
      return new Lz4DecompressContext(maxOutputSize);
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
function concatChunks(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0];
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
export function createDecompressStream(
  maxOutputSize?: number,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  let ctx: StreamContext | null = null;
  // The input received before the format is detected. Emptied once the
  // format is known, or the stream has closed, to release that memory.
  let buffered: Uint8Array[] = [];
  let bufferedLength = 0;
  // Detection runs once this much input has arrived, then each time the
  // input doubles, so that small chunks do not make it run on every chunk.
  let detectAt = MAGIC_LENGTH;

  function start(
    format: CompressionFormat,
    data: Uint8Array,
    controller: Controller,
  ): StreamContext {
    const context = createDecompressContext(format, maxOutputSize);
    ctx = context;
    buffered = [];
    enqueueIfNonEmpty(controller, context.transform(data));
    return context;
  }

  return closingStream(
    (chunk, controller) => {
      if (ctx) {
        enqueueIfNonEmpty(controller, ctx.transform(chunk));
        return;
      }

      // Copy the chunk: the writer may reuse its memory once this returns.
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      buffered.push(copy);
      bufferedLength += copy.byteLength;
      if (bufferedLength < detectAt) return;

      const data = concatChunks(buffered, bufferedLength);
      const format = detectFormat(data);
      // More input may still reveal the format, as for the start of a
      // brotli stream or of a skippable frame.
      if (format === 'unknown' && bufferedLength < DETECT_LIMIT) {
        buffered = [data];
        detectAt = Math.min(2 * bufferedLength, DETECT_LIMIT);
        return;
      }
      start(format, data, controller);
    },
    (controller) => {
      let context = ctx;
      if (!context) {
        // The input ended before its format was detected. Empty input has no
        // detectable format and throws.
        const data = concatChunks(buffered, bufferedLength);
        context = start(detectFormat(data), data, controller);
      }

      enqueueIfNonEmpty(controller, context.flush());
      // finish() verifies that the input contained the whole stream.
      enqueueIfNonEmpty(controller, context.finish());
    },
    () => {
      ctx?.close();
      buffered = [];
    },
  );
}
