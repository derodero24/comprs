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
import {
  createBrotliCompressTransform,
  createGzipCompressTransform,
  createZstdCompressTransform,
} from '@derodero24/comprs/node';

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
    transform(chunk) {
      checksum = adler32(chunk, checksum);
      return frame(context.transform(chunk));
    },
    flush: () => frame(context.flush()),
    finish: () => frame(Buffer.concat([context.finish(), zlibTrailer(checksum)])),
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

/** Create a Node.js Transform that compresses to the zlib format. */
function createZlibCompressTransform(level: number | undefined): Transform {
  const encoder = createZlibEncoder(level);

  const push = (stream: Transform, output: Uint8Array): void => {
    if (output.byteLength > 0) stream.push(output);
  };

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        push(this, encoder.transform(chunk));
        callback();
      } catch (err) {
        callback(toError(err));
      }
    },
    flush(callback: TransformCallback) {
      try {
        push(this, encoder.finish());
        callback();
      } catch (err) {
        callback(toError(err));
      }
    },
  });
}

/**
 * Create a Node.js Transform stream for the given encoding.
 */
export function createCompressTransform(encoding: Encoding, level?: LevelOptions): Transform {
  switch (encoding) {
    case 'zstd':
      return createZstdCompressTransform(level?.zstd);
    case 'br':
      return createBrotliCompressTransform(level?.br);
    case 'gzip':
      return createGzipCompressTransform(level?.gzip);
    case 'deflate':
      return createZlibCompressTransform(level?.deflate);
  }
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
