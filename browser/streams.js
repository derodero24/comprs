// Browser module of `@derodero24/comprs/streams` (the `browser` condition of
// that subpath): the Web Streams helpers of ../streams.js, built on the stream
// contexts of the browser entry, which loads the WebAssembly module. Like the
// entry, it can only be imported.

import {
  BrotliCompressContext,
  BrotliCompressDictContext,
  BrotliDecompressContext,
  BrotliDecompressDictContext,
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

function enqueueIfNonEmpty(controller, result) {
  // A context returns a new Uint8Array on each call, so it needs no copy.
  if (result.byteLength > 0) {
    controller.enqueue(result);
  }
}

/** Emit what a context returns at the end of the input. */
function end(context, controller) {
  enqueueIfNonEmpty(controller, context.flush());
  // finish() verifies that the input contained the whole stream.
  enqueueIfNonEmpty(controller, context.finish());
}

/**
 * A TransformStream with the transform() and flush() of `transformer`, which
 * use the context that `getContext()` returns, if any. The stream frees the
 * WebAssembly memory of that context as soon as it ends or fails, rather than
 * whenever garbage collection gets to the context, and when it is cancelled,
 * in runtimes that call the cancel() method of a transformer.
 */
function freeingStream(getContext, transformer) {
  let freed = false;
  const free = () => {
    const context = getContext();
    if (context !== null && !freed) {
      freed = true;
      context.free();
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      try {
        transformer.transform(chunk, controller);
      } catch (error) {
        free();
        throw error;
      }
    },
    flush(controller) {
      try {
        transformer.flush(controller);
      } finally {
        free();
      }
    },
    cancel: free,
  });
}

/** A TransformStream that passes its input through a stream context. */
function contextStream(context) {
  return freeingStream(() => context, {
    transform(chunk, controller) {
      enqueueIfNonEmpty(controller, context.transform(chunk));
    },
    flush(controller) {
      end(context, controller);
    },
  });
}

/**
 * Create a streaming brotli compression TransformStream.
 *
 * @param {number} [quality=6] Compression quality (0-11)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createBrotliCompressStream(quality) {
  return contextStream(new BrotliCompressContext(quality));
}

/**
 * Create a streaming brotli decompression TransformStream.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createBrotliDecompressStream(maxOutputSize) {
  return contextStream(new BrotliDecompressContext(maxOutputSize));
}

/**
 * Create a streaming zstd compression TransformStream.
 *
 * @param {number} [level=3] Compression level (1-22, or negative for fast mode)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createZstdCompressStream(level) {
  return contextStream(new ZstdCompressContext(level));
}

/**
 * Create a streaming zstd decompression TransformStream.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createZstdDecompressStream(maxOutputSize) {
  return contextStream(new ZstdDecompressContext(maxOutputSize));
}

/**
 * Create a streaming gzip compression TransformStream.
 *
 * @param {number} [level=6] Compression level (0-9)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createGzipCompressStream(level) {
  return contextStream(new GzipCompressContext(level));
}

/**
 * Create a streaming gzip decompression TransformStream.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createGzipDecompressStream(maxOutputSize) {
  return contextStream(new GzipDecompressContext(maxOutputSize));
}

/**
 * Create a streaming raw deflate compression TransformStream.
 *
 * @param {number} [level=6] Compression level (0-9)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createDeflateCompressStream(level) {
  return contextStream(new DeflateCompressContext(level));
}

/**
 * Create a streaming raw deflate decompression TransformStream.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createDeflateDecompressStream(maxOutputSize) {
  return contextStream(new DeflateDecompressContext(maxOutputSize));
}

/**
 * Create a streaming brotli compression TransformStream with a custom dictionary.
 *
 * @param {Uint8Array} dict Custom dictionary
 * @param {number} [quality=6] Compression quality (0-11)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createBrotliCompressDictStream(dict, quality) {
  return contextStream(new BrotliCompressDictContext(dict, quality));
}

/**
 * Create a streaming brotli decompression TransformStream with a custom dictionary.
 *
 * @param {Uint8Array} dict Custom dictionary (must match the one used for compression)
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createBrotliDecompressDictStream(dict, maxOutputSize) {
  return contextStream(new BrotliDecompressDictContext(dict, maxOutputSize));
}

/**
 * Create a streaming zstd compression TransformStream with a pre-trained dictionary.
 *
 * @param {Uint8Array} dict Pre-trained dictionary
 * @param {number} [level=3] Compression level (1-22, or negative for fast mode)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createZstdCompressDictStream(dict, level) {
  return contextStream(new ZstdCompressDictContext(dict, level));
}

/**
 * Create a streaming zstd decompression TransformStream with a pre-trained dictionary.
 *
 * @param {Uint8Array} dict Pre-trained dictionary (must match the one used for compression)
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createZstdDecompressDictStream(dict, maxOutputSize) {
  return contextStream(new ZstdDecompressDictContext(dict, maxOutputSize));
}

/**
 * Create a streaming LZ4 frame compression TransformStream.
 *
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createLz4CompressStream() {
  return contextStream(new Lz4CompressContext());
}

/**
 * Create a streaming LZ4 frame decompression TransformStream.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createLz4DecompressStream(maxOutputSize) {
  return contextStream(new Lz4DecompressContext(maxOutputSize));
}

function createDecompressContext(format, maxOutputSize) {
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

/**
 * Concatenate `chunks`, whose lengths add up to `length`.
 *
 * @param {Uint8Array[]} chunks
 * @param {number} length
 * @returns {Uint8Array}
 */
function concatChunks(chunks, length) {
  if (chunks.length === 1) return chunks[0];
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
 * detectFormat and delegates to the appropriate decompression context.
 * Raw deflate is not supported (no magic bytes to distinguish it).
 *
 * The input is buffered until the format is detected: up to 64 KiB, or the
 * whole input if it is shorter. The stream errors if the format is still
 * unknown then.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createDecompressStream(maxOutputSize) {
  let ctx = null;
  // The input received before the format is detected.
  let buffered = [];
  let bufferedLength = 0;
  // Detection runs once this much input has arrived, then each time the
  // input doubles, so that small chunks do not make it run on every chunk.
  let detectAt = MAGIC_LENGTH;

  function start(format, data, controller) {
    ctx = createDecompressContext(format, maxOutputSize);
    buffered = null;
    enqueueIfNonEmpty(controller, ctx.transform(data));
  }

  return freeingStream(() => ctx, {
    transform(chunk, controller) {
      if (ctx) {
        enqueueIfNonEmpty(controller, ctx.transform(chunk));
        return;
      }

      const copy = new Uint8Array(chunk);
      buffered.push(copy);
      bufferedLength += copy.length;
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
    flush(controller) {
      if (!ctx) {
        // The input ended before its format was detected. Empty input has no
        // detectable format and throws.
        const data = concatChunks(buffered, bufferedLength);
        start(detectFormat(data), data, controller);
      }

      end(ctx, controller);
    },
  });
}
