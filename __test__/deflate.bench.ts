import { randomBytes } from 'node:crypto';
import { bench, describe } from 'vitest';
import { deflateCompress, deflateDecompress } from '../index.js';

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
