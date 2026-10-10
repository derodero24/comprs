// Browser module of `@derodero24/comprs/streams` (the `browser` condition of
// that subpath): the Web Streams helpers of ../streams.js, built on the stream
// contexts of the browser entry, which loads the WebAssembly module. Like the
// entry, it can only be imported. The helpers take the arguments of those of
// ../streams.js, with `Uint8Array` where those take `Buffer | Uint8Array`;
// __test__/browser-streams.spec.ts checks that their declarations agree.

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
  free(): void;
}

/** The controller of the streams, which emit Uint8Array chunks. */
type Controller = TransformStreamDefaultController<Uint8Array>;

/** What a stream does with each input chunk and at the end of the input. */
interface ContextTransformer {
  transform(chunk: Uint8Array, controller: Controller): void;
  flush(controller: Controller): void;
}

/**
 * The transformer of a stream, with the cancel() method that the Streams
 * standard defines but the DOM library of TypeScript does not declare.
 */
type CancelableTransformer = Transformer<ArrayBufferLike | ArrayBufferView, Uint8Array> & {
  cancel(): void;
};

/**
 * Whether `value` is an ArrayBuffer or a SharedArrayBuffer, by the tag that
 * Object.prototype.toString() reads.
 */
function isAnyArrayBuffer(value: unknown): value is ArrayBuffer | SharedArrayBuffer {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/**
 * View `chunk`, a chunk written to a stream, as bytes. Like ../streams.js,
 * the streams accept what `CompressionStream` accepts, any ArrayBuffer or
 * ArrayBufferView, as well as a SharedArrayBuffer, and read it byte for
 * byte: a typed array is not converted element by element.
 */
function toUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  // Unlike instanceof, this also recognizes an ArrayBuffer or a
  // SharedArrayBuffer from another realm, such as an iframe. This module
  // cannot use util.types.isAnyArrayBuffer(), as ../streams.js does, since
  // it must not import Node.js built-ins.
  if (isAnyArrayBuffer(chunk)) return new Uint8Array(chunk);
  throw new TypeError('chunk must be an ArrayBuffer or ArrayBufferView');
}

function enqueueIfNonEmpty(controller: Controller, result: Uint8Array): void {
  // A context returns a new Uint8Array on each call, so it needs no copy.
  if (result.byteLength > 0) {
    controller.enqueue(result);
  }
}

/** Emit what a context returns at the end of the input. */
function end(context: StreamContext, controller: Controller): void {
  enqueueIfNonEmpty(controller, context.flush());
  // finish() verifies that the input contained the whole stream.
  enqueueIfNonEmpty(controller, context.finish());
}

/**
 * A TransformStream with the transform() and flush() of `transformer`, which
 * use the context that `getContext()` returns, if any. `transformer`
 * receives each input chunk as a Uint8Array, and a chunk that is not an
 * ArrayBuffer or ArrayBufferView errors the stream. The stream frees the
 * WebAssembly memory of that context as soon as it ends or fails, rather than
 * whenever garbage collection gets to the context, and when it is cancelled,
 * in runtimes that call the cancel() method of a transformer.
 */
function freeingStream(
  getContext: () => StreamContext | null,
  transformer: ContextTransformer,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  let freed = false;
  const free = (): void => {
    const context = getContext();
    if (context !== null && !freed) {
      freed = true;
      context.free();
    }
  };
  const streamTransformer: CancelableTransformer = {
    transform(chunk: ArrayBufferLike | ArrayBufferView, controller: Controller): void {
      try {
        transformer.transform(toUint8Array(chunk), controller);
      } catch (error) {
        free();
        throw error;
      }
    },
    flush(controller: Controller): void {
      try {
        transformer.flush(controller);
      } finally {
        free();
      }
    },
    cancel: free,
  };
  return new TransformStream(streamTransformer);
}

/** A TransformStream that passes its input through a stream context. */
function contextStream(
  context: StreamContext,
): TransformStream<ArrayBufferLike | ArrayBufferView, Uint8Array> {
  return freeingStream(() => context, {
    transform(chunk: Uint8Array, controller: Controller): void {
      enqueueIfNonEmpty(controller, context.transform(chunk));
    },
    flush(controller: Controller): void {
      end(context, controller);
    },
  });
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
  dict: Uint8Array,
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
  dict: Uint8Array,
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
  dict: Uint8Array,
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
  dict: Uint8Array,
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
 * The stream errors on empty input.
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
    offset += chunk.length;
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
  // format is known, to release that memory.
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

  return freeingStream(() => ctx, {
    transform(chunk: Uint8Array, controller: Controller): void {
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
    flush(controller: Controller): void {
      let context = ctx;
      if (!context) {
        // The input ended before its format was detected. Empty input has no
        // detectable format and throws.
        const data = concatChunks(buffered, bufferedLength);
        context = start(detectFormat(data), data, controller);
      }

      end(context, controller);
    },
  });
}
