import { Transform, type TransformCallback } from 'node:stream';

import { DeflateCompressContext } from '@derodero24/comprs';
import {
  createBrotliCompressTransform,
  createGzipCompressTransform,
  createZstdCompressTransform,
} from '@derodero24/comprs/node';

import type { Encoding, LevelOptions } from './types.js';
import { ADLER32_INITIAL, adler32, zlibHeader, zlibTrailer } from './zlib.js';

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Create a Transform that compresses to the zlib format (RFC 1950), which is
 * what the `deflate` content coding means. The header goes in front of the
 * first output, and the Adler-32 checksum of the input after the raw DEFLATE
 * stream.
 */
function createZlibCompressTransform(level: number | undefined): Transform {
  const context = new DeflateCompressContext(level);
  let header: Uint8Array | undefined = zlibHeader(level);
  let checksum = ADLER32_INITIAL;

  const push = (stream: Transform, output: Uint8Array): void => {
    if (output.byteLength === 0) return;
    stream.push(header ? Buffer.concat([header, output]) : output);
    header = undefined;
  };

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        checksum = adler32(chunk, checksum);
        push(this, context.transform(chunk));
        callback();
      } catch (err) {
        callback(toError(err));
      }
    },
    flush(callback: TransformCallback) {
      try {
        push(this, Buffer.concat([context.finish(), zlibTrailer(checksum)]));
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
