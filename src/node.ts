import { Transform } from 'node:stream';
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

/** The methods of the stream contexts that the transforms call. */
interface StreamContext {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  finish(): Uint8Array;
  close(): void;
}

/**
 * Push `buf`, which a stream context returned, in chunks of at most
 * `readableHighWaterMark` bytes. The chunks are views of `buf`, not copies.
 *
 * A single input chunk can decompress to many megabytes; slicing keeps the
 * chunks that readers receive as small as those of `node:zlib`. The return
 * value of push() is ignored: backpressure still applies between input
 * chunks, as the stream calls transform() again only once readers catch up.
 */
function pushSliced(stream: Transform, buf: Uint8Array): void {
  if (buf.byteLength === 0) return;
  const size = stream.readableHighWaterMark || 65536;
  if (buf.byteLength <= size) {
    stream.push(buf);
    return;
  }
  for (let i = 0; i < buf.byteLength; i += size) {
    stream.push(buf.subarray(i, i + size));
  }
}

/**
 * Create a Transform from `transform` and `flush`, which call stream
 * contexts. `close` closes the contexts once the stream is destroyed, which
 * happens when it ends, fails or is destroyed early, and releases their
 * native memory right away instead of when the garbage collector gets to
 * them.
 */
function closingTransform(
  transform: (stream: Transform, chunk: Buffer) => void,
  flush: (stream: Transform) => void,
  close: () => void,
): Transform {
  return new Transform({
    // Without objectMode, every chunk written is a Buffer.
    transform(chunk: Buffer, _encoding, callback) {
      try {
        transform(this, chunk);
        callback();
      } catch (err) {
        // Pass on what was thrown as it is. Under Jest, which runs this
        // module in a vm context, the errors of the native addon are not
        // instances of that context's Error, and wrapping them would drop
        // their code.
        callback(err as Error);
      }
    },
    flush(callback) {
      try {
        flush(this);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    destroy(err, callback) {
      close();
      callback(err);
    },
  });
}

/** Create a Transform that feeds its input through `ctx`. */
function contextTransform(ctx: StreamContext): Transform {
  return closingTransform(
    (stream, chunk) => pushSliced(stream, ctx.transform(chunk)),
    (stream) => {
      pushSliced(stream, ctx.flush());
      pushSliced(stream, ctx.finish());
    },
    () => ctx.close(),
  );
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
export function createZstdCompressTransform(level?: number): Transform {
  return contextTransform(new ZstdCompressContext(level));
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
export function createZstdDecompressTransform(maxOutputSize?: number): Transform {
  return contextTransform(new ZstdDecompressContext(maxOutputSize));
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
export function createGzipCompressTransform(level?: number): Transform {
  return contextTransform(new GzipCompressContext(level));
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
export function createGzipDecompressTransform(maxOutputSize?: number): Transform {
  return contextTransform(new GzipDecompressContext(maxOutputSize));
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
export function createDeflateCompressTransform(level?: number): Transform {
  return contextTransform(new DeflateCompressContext(level));
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
export function createDeflateDecompressTransform(maxOutputSize?: number): Transform {
  return contextTransform(new DeflateDecompressContext(maxOutputSize));
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
export function createBrotliCompressTransform(quality?: number): Transform {
  return contextTransform(new BrotliCompressContext(quality));
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
export function createBrotliDecompressTransform(maxOutputSize?: number): Transform {
  return contextTransform(new BrotliDecompressContext(maxOutputSize));
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
export function createZstdCompressDictTransform(
  dict: Buffer | Uint8Array,
  level?: number,
): Transform {
  return contextTransform(new ZstdCompressDictContext(dict, level));
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
export function createZstdDecompressDictTransform(
  dict: Buffer | Uint8Array,
  maxOutputSize?: number,
): Transform {
  return contextTransform(new ZstdDecompressDictContext(dict, maxOutputSize));
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
export function createBrotliCompressDictTransform(
  dict: Buffer | Uint8Array,
  quality?: number,
): Transform {
  return contextTransform(new BrotliCompressDictContext(dict, quality));
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
export function createBrotliDecompressDictTransform(
  dict: Buffer | Uint8Array,
  maxOutputSize?: number,
): Transform {
  return contextTransform(new BrotliDecompressDictContext(dict, maxOutputSize));
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
export function createDecompressTransform(maxOutputSize?: number): Transform {
  let ctx: StreamContext | null = null;
  // The input received before the format is detected. Emptied once the
  // format is known, or the transform has closed, to release that memory.
  let buffered: Buffer[] = [];
  let bufferedLength = 0;
  // Detection runs once this much input has arrived, then each time the
  // input doubles, so that small chunks do not make it run on every chunk.
  let detectAt = MAGIC_LENGTH;

  function start(stream: Transform, format: CompressionFormat, data: Buffer): StreamContext {
    const context = createDecompressContext(format, maxOutputSize);
    ctx = context;
    buffered = [];
    pushSliced(stream, context.transform(data));
    return context;
  }

  return closingTransform(
    (stream, chunk) => {
      if (ctx) {
        pushSliced(stream, ctx.transform(chunk));
        return;
      }

      const copy = Buffer.from(chunk);
      buffered.push(copy);
      bufferedLength += copy.length;
      if (bufferedLength < detectAt) return;

      const data = Buffer.concat(buffered, bufferedLength);
      const format = detectFormat(data);
      // More input may still reveal the format, as for the start of a
      // brotli stream or of a skippable frame.
      if (format === 'unknown' && bufferedLength < DETECT_LIMIT) {
        buffered = [data];
        detectAt = Math.min(2 * bufferedLength, DETECT_LIMIT);
        return;
      }
      start(stream, format, data);
    },
    (stream) => {
      let context = ctx;
      if (!context) {
        // The input ended before its format was detected. Empty input has
        // no detectable format and throws.
        const data = Buffer.concat(buffered, bufferedLength);
        context = start(stream, detectFormat(data), data);
      }

      pushSliced(stream, context.flush());
      // finish() verifies that the input contained the whole stream.
      pushSliced(stream, context.finish());
    },
    () => {
      ctx?.close();
      buffered = [];
    },
  );
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
export function createLz4CompressTransform(): Transform {
  return contextTransform(new Lz4CompressContext());
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
export function createLz4DecompressTransform(maxOutputSize?: number): Transform {
  return contextTransform(new Lz4DecompressContext(maxOutputSize));
}
