import { Transform, type TransformCallback } from 'node:stream';

import {
  BrotliCompressContext,
  brotliCompressAsync,
  DeflateCompressContext,
  deflateCompressAsync,
  GzipCompressContext,
  gzipCompressAsync,
  ZstdCompressContext,
  zstdCompressAsync,
} from '@derodero24/comprs';

import type { Encoding, LevelOptions } from './types.js';
import { ADLER32_INITIAL, adler32, toZlib, zlibHeader, zlibTrailer } from './zlib.js';

/**
 * A streaming compressor for one response body, as the compression contexts
 * of comprs provide it. Each method returns the output it produced, which
 * may be empty while the compressor buffers input.
 */
export interface Encoder {
  /** Compress a chunk of the body. */
  transform(chunk: Uint8Array): Uint8Array;
  /** Emit all the input so far in a form the client can decode right away. */
  flush(): Uint8Array;
  /** End the compressed stream; the encoder cannot be used afterwards. */
  finish(): Uint8Array;
  /**
   * Release the native state of the encoder now rather than when it is
   * garbage-collected; the encoder cannot be used afterwards. `finish()`
   * releases the state too, and closing a finished or closed encoder does
   * nothing.
   */
  close(): void;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Create an encoder for the zlib format (RFC 1950), which is what the
 * `deflate` content coding means. The header goes in front of the first
 * output, and the Adler-32 checksum of the input after the raw DEFLATE
 * stream.
 */
function createZlibEncoder(level: number | undefined): Encoder {
  const context = new DeflateCompressContext(level);
  let header: Uint8Array | undefined = zlibHeader(level);
  let checksum = ADLER32_INITIAL;

  const frame = (output: Uint8Array): Uint8Array => {
    if (!header || output.byteLength === 0) return output;
    const framed = Buffer.concat([header, output]);
    header = undefined;
    return framed;
  };

  return {
    transform(chunk: Uint8Array): Uint8Array {
      checksum = adler32(chunk, checksum);
      return frame(context.transform(chunk));
    },
    flush: () => frame(context.flush()),
    finish: () => frame(Buffer.concat([context.finish(), zlibTrailer(checksum)])),
    close: () => context.close(),
  };
}

/** Create a streaming compressor for the given encoding. */
export function createEncoder(encoding: Encoding, level?: LevelOptions): Encoder {
  switch (encoding) {
    case 'zstd':
      return new ZstdCompressContext(level?.zstd);
    case 'br':
      return new BrotliCompressContext(level?.br);
    case 'gzip':
      return new GzipCompressContext(level?.gzip);
    case 'deflate':
      return createZlibEncoder(level?.deflate);
  }
}

/**
 * A Node.js Transform that compresses with an encoder. Destroying the stream,
 * which happens when it ends, fails or is destroyed early, closes the
 * encoder, so that an aborted response releases its native state right away
 * instead of when the garbage collector gets to it.
 *
 * Each result is pushed as one chunk: compressed output is no larger than
 * about the input that produced it, so it needs no slicing, unlike the
 * output of decompression.
 */
class EncoderTransform extends Transform {
  readonly #encoder: Encoder;

  constructor(encoder: Encoder) {
    super();
    this.#encoder = encoder;
  }

  /** Push compressed output, if there is any. */
  #push(output: Uint8Array): void {
    if (output.byteLength > 0) this.push(output);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.#push(this.#encoder.transform(chunk));
      callback();
    } catch (err) {
      callback(toError(err));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.#push(this.#encoder.finish());
      callback();
    } catch (err) {
      callback(toError(err));
    }
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    this.#encoder.close();
    callback(err);
  }
}

/**
 * Create a Node.js Transform stream for the given encoding.
 */
export function createCompressTransform(encoding: Encoding, level?: LevelOptions): Transform {
  return new EncoderTransform(createEncoder(encoding, level));
}

/**
 * Compress a whole body in one call. The compression runs on the libuv
 * thread pool, so that a large body or a high level does not hold up the
 * event loop; only the Adler-32 checksum of `deflate` is computed here.
 */
export async function compressBufferAsync(
  encoding: Encoding,
  data: Uint8Array,
  level?: LevelOptions,
): Promise<Buffer> {
  switch (encoding) {
    case 'zstd':
      return zstdCompressAsync(data, level?.zstd);
    case 'br':
      return brotliCompressAsync(data, level?.br);
    case 'gzip':
      return gzipCompressAsync(data, level?.gzip);
    case 'deflate': {
      const deflated = await deflateCompressAsync(data, level?.deflate);
      const zlib = toZlib(deflated, data, level?.deflate);
      return Buffer.from(zlib.buffer, zlib.byteOffset, zlib.byteLength);
    }
  }
}
