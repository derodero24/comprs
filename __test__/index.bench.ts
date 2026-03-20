import { bench, describe } from 'vitest';
import { zstdCompress, zstdDecompress } from '../index.js';

const SMALL = Buffer.from('Hello, zflate! '.repeat(10));
const MEDIUM = Buffer.alloc(10_000);
for (let i = 0; i < MEDIUM.length; i++) MEDIUM[i] = i % 256;
const LARGE = Buffer.alloc(1_000_000);
for (let i = 0; i < LARGE.length; i++) LARGE[i] = i % 256;

const SMALL_COMPRESSED = zstdCompress(SMALL);
const MEDIUM_COMPRESSED = zstdCompress(MEDIUM);
const LARGE_COMPRESSED = zstdCompress(LARGE);

describe('zstd compress', () => {
  bench('150B', () => {
    zstdCompress(SMALL);
  });

  bench('10KB', () => {
    zstdCompress(MEDIUM);
  });

  bench('1MB', () => {
    zstdCompress(LARGE);
  });
});

describe('zstd decompress', () => {
  bench('150B', () => {
    zstdDecompress(SMALL_COMPRESSED);
  });

  bench('10KB', () => {
    zstdDecompress(MEDIUM_COMPRESSED);
  });

  bench('1MB', () => {
    zstdDecompress(LARGE_COMPRESSED);
  });
});
