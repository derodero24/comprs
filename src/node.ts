import { Transform, type TransformCallback } from 'node:stream';
import { markAsUntransferable } from 'node:worker_threads';
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
const canMarkUntransferable: boolean = probeMarkAsUntransferable();

function probeMarkAsUntransferable(): boolean {
  try {
    markAsUntransferable(new ArrayBuffer(0));
    return true;
  } catch {
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
function pushSliced(stream: Transform, buf: Uint8Array): void {
  const length = buf.byteLength;
  if (length === 0) return;
  const size = stream.readableHighWaterMark || 65536;
  if (length <= size) {
    stream.push(buf);
    return;
  }
  if (canMarkUntransferable && length <= COPY_LIMIT) markAsUntransferable(buf.buffer);
  for (let i = 0; i < length; i += size) {
    stream.push(buf.subarray(i, i + size));
    if (buf.byteLength !== length) {
      throw new Error(
        'an output chunk was transferred, which detached the other chunks of the same result; copy a chunk with new Uint8Array(chunk) before transferring it',
      );
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
function closingTransform(
  transform: (stream: Transform, chunk: Buffer) => void,
  flush: (stream: Transform) => void,
  close: () => void,
): Transform {
  return new Transform({
    // Without objectMode, every chunk written is a Buffer.
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
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
    flush(callback: TransformCallback): void {
      try {
        flush(this);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    destroy(err: Error | null, callback: (error?: Error | null) => void): void {
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
 * default, 16 KiB on Windows).
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
 * default, 16 KiB on Windows).
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
 * default, 16 KiB on Windows).
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
 * default, 16 KiB on Windows).
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
 * default, 16 KiB on Windows).
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
 * default, 16 KiB on Windows).
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
 * default, 16 KiB on Windows).
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
 * default, 16 KiB on Windows).
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
 * default, 16 KiB on Windows).
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
 * default, 16 KiB on Windows).
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
export function createBrotliCompressDictTransform(
  dict: Buffer | Uint8Array,
  quality?: number,
): Transform {
  return contextTransform(new BrotliCompressDictContext(dict, quality, { incremental: true }));
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
      return new Lz4DecompressContext(maxOutputSize, { incremental: true });
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
 * default, 16 KiB on Windows).
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
 * default, 16 KiB on Windows).
 */
export function createLz4CompressTransform(): Transform {
  return contextTransform(new Lz4CompressContext());
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
export function createLz4DecompressTransform(maxOutputSize?: number): Transform {
  return contextTransform(new Lz4DecompressContext(maxOutputSize, { incremental: true }));
}
