import { bench, describe } from 'vitest';
import { gzipCompress, gzipDecompress } from '../index.js';

// --- Patterned data (compressible) ---
const SMALL = Buffer.from('Hello, zflate! '.repeat(10));
const MEDIUM = Buffer.alloc(10_000);
for (let i = 0; i < MEDIUM.length; i++) MEDIUM[i] = i % 256;
const LARGE = Buffer.alloc(1_000_000);
for (let i = 0; i < LARGE.length; i++) LARGE[i] = i % 256;

// --- Deterministic pseudo-random data (incompressible) ---
// Uses a linear congruential generator for reproducible benchmark inputs,
// avoiding CodSpeed instruction count variance from non-deterministic randomBytes.
const deterministicBytes = (size: number, seed: number): Buffer => {
  const out = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (1664525 * x + 1013904223) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
};
const RANDOM_SMALL = deterministicBytes(150, 0x1234);
const RANDOM_MEDIUM = deterministicBytes(10_000, 0x5678);
const RANDOM_LARGE = deterministicBytes(1_000_000, 0x9abc);

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
