import { bench, describe } from 'vitest';
import { deflateCompress, deflateDecompress } from '../index.js';

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
const SMALL_COMPRESSED = deflateCompress(SMALL);
const MEDIUM_COMPRESSED = deflateCompress(MEDIUM);
const LARGE_COMPRESSED = deflateCompress(LARGE);
const RANDOM_SMALL_COMPRESSED = deflateCompress(RANDOM_SMALL);
const RANDOM_MEDIUM_COMPRESSED = deflateCompress(RANDOM_MEDIUM);
const RANDOM_LARGE_COMPRESSED = deflateCompress(RANDOM_LARGE);

describe('deflate compress (patterned)', () => {
  bench('150B', () => {
    deflateCompress(SMALL);
  });

  bench('10KB', () => {
    deflateCompress(MEDIUM);
  });

  bench('1MB', () => {
    deflateCompress(LARGE);
  });
});

describe('deflate compress (random)', () => {
  bench('150B', () => {
    deflateCompress(RANDOM_SMALL);
  });

  bench('10KB', () => {
    deflateCompress(RANDOM_MEDIUM);
  });

  bench('1MB', () => {
    deflateCompress(RANDOM_LARGE);
  });
});

describe('deflate decompress (patterned)', () => {
  bench('150B', () => {
    deflateDecompress(SMALL_COMPRESSED);
  });

  bench('10KB', () => {
    deflateDecompress(MEDIUM_COMPRESSED);
  });

  bench('1MB', () => {
    deflateDecompress(LARGE_COMPRESSED);
  });
});

describe('deflate decompress (random)', () => {
  bench('150B', () => {
    deflateDecompress(RANDOM_SMALL_COMPRESSED);
  });

  bench('10KB', () => {
    deflateDecompress(RANDOM_MEDIUM_COMPRESSED);
  });

  bench('1MB', () => {
    deflateDecompress(RANDOM_LARGE_COMPRESSED);
  });
});
