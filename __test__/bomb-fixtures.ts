import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { constants, createBrotliCompress, createDeflateRaw, createGzip } from 'node:zlib';
import { zstdCompress } from '../index.js';

const MIB = 1024 * 1024;

export const BOMB_FORMATS = ['gzip', 'deflate', 'brotli', 'zstd'] as const;
export type BombFormat = (typeof BOMB_FORMATS)[number];

function* zeroChunks(mib: number): Generator<Buffer> {
  const chunk = Buffer.alloc(MIB);
  for (let i = 0; i < mib; i++) {
    yield chunk;
  }
}

/**
 * Build a small input that decompresses to `mib` MiB of zeros.
 *
 * node:zlib receives the zeros one MiB at a time, so building a bomb never
 * holds its decompressed size in memory. zstd uses concatenated frames.
 */
export function makeBomb(format: BombFormat, mib: number): Promise<Buffer> {
  switch (format) {
    case 'gzip':
      return buffer(Readable.from(zeroChunks(mib)).pipe(createGzip()));
    case 'deflate':
      return buffer(Readable.from(zeroChunks(mib)).pipe(createDeflateRaw()));
    case 'brotli':
      return buffer(
        Readable.from(zeroChunks(mib)).pipe(
          createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }),
        ),
      );
    case 'zstd': {
      const frame = zstdCompress(Buffer.alloc(MIB));
      return Promise.resolve(Buffer.concat(Array.from({ length: mib }, () => frame)));
    }
  }
}

/** Peak resident set size of this process so far, in KiB. */
export function peakRssKiB(): number {
  return process.resourceUsage().maxRSS;
}
