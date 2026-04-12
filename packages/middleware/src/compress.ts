import type { Transform } from 'node:stream';

import {
  createBrotliCompressTransform,
  createDeflateCompressTransform,
  createGzipCompressTransform,
  createZstdCompressTransform,
} from '@derodero24/comprs/node';

import type { Encoding, LevelOptions } from './types.js';

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
      return createDeflateCompressTransform(level?.deflate);
  }
}
