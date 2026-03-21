import { randomBytes } from 'node:crypto';
import { bench, describe } from 'vitest';
import { gzipCompress, gzipDecompress } from '../index.js';

// --- Patterned data (compressible) ---
const SMALL = Buffer.from('Hello, zflate! '.repeat(10));
const MEDIUM = Buffer.alloc(10_000);
for (let i = 0; i < MEDIUM.length; i++) MEDIUM[i] = i % 256;
const LARGE = Buffer.alloc(1_000_000);
for (let i = 0; i < LARGE.length; i++) LARGE[i] = i % 256;

// --- Random data (incompressible) ---
const RANDOM_SMALL = randomBytes(150);
const RANDOM_MEDIUM = randomBytes(10_000);
const RANDOM_LARGE = randomBytes(1_000_000);

// --- Pre-compressed data for decompression benchmarks ---
const SMALL_COMPRESSED = gzipCompress(SMALL);
const MEDIUM_COMPRESSED = gzipCompress(MEDIUM);
const LARGE_COMPRESSED = gzipCompress(LARGE);
const RANDOM_SMALL_COMPRESSED = gzipCompress(RANDOM_SMALL);
const RANDOM_MEDIUM_COMPRESSED = gzipCompress(RANDOM_MEDIUM);
const RANDOM_LARGE_COMPRESSED = gzipCompress(RANDOM_LARGE);

describe('gzip compress (patterned)', () => {
  bench('150B', () => {
    gzipCompress(SMALL);
  });

  bench('10KB', () => {
    gzipCompress(MEDIUM);
  });

  bench('1MB', () => {
    gzipCompress(LARGE);
  });
});

describe('gzip compress (random)', () => {
  bench('150B', () => {
    gzipCompress(RANDOM_SMALL);
  });

  bench('10KB', () => {
    gzipCompress(RANDOM_MEDIUM);
  });

  bench('1MB', () => {
    gzipCompress(RANDOM_LARGE);
  });
});

describe('gzip decompress (patterned)', () => {
  bench('150B', () => {
    gzipDecompress(SMALL_COMPRESSED);
  });

  bench('10KB', () => {
    gzipDecompress(MEDIUM_COMPRESSED);
  });

  bench('1MB', () => {
    gzipDecompress(LARGE_COMPRESSED);
  });
});

describe('gzip decompress (random)', () => {
  bench('150B', () => {
    gzipDecompress(RANDOM_SMALL_COMPRESSED);
  });

  bench('10KB', () => {
    gzipDecompress(RANDOM_MEDIUM_COMPRESSED);
  });

  bench('1MB', () => {
    gzipDecompress(RANDOM_LARGE_COMPRESSED);
  });
});
