import { bench, describe } from 'vitest';
import { brotliCompress, brotliDecompress } from '../index.js';
import {
  JSON_DATA,
  LARGE,
  MEDIUM,
  RANDOM_LARGE,
  RANDOM_MEDIUM,
  RANDOM_SMALL,
  SMALL,
  TEXT_DATA,
} from './bench-fixtures.js';

// --- Pre-compressed data for decompression benchmarks ---
const SMALL_COMPRESSED = brotliCompress(SMALL);
const MEDIUM_COMPRESSED = brotliCompress(MEDIUM);
const LARGE_COMPRESSED = brotliCompress(LARGE);
const RANDOM_SMALL_COMPRESSED = brotliCompress(RANDOM_SMALL);
const RANDOM_MEDIUM_COMPRESSED = brotliCompress(RANDOM_MEDIUM);
const RANDOM_LARGE_COMPRESSED = brotliCompress(RANDOM_LARGE);
const JSON_COMPRESSED = brotliCompress(JSON_DATA);
const TEXT_COMPRESSED = brotliCompress(TEXT_DATA);

describe('brotli compress (patterned)', () => {
  bench('150B', () => {
    brotliCompress(SMALL);
  });

  bench('10KB', () => {
    brotliCompress(MEDIUM);
  });

  bench('1MB', () => {
    brotliCompress(LARGE);
  });
});

describe('brotli compress (random)', () => {
  bench('150B', () => {
    brotliCompress(RANDOM_SMALL);
  });

  bench('10KB', () => {
    brotliCompress(RANDOM_MEDIUM);
  });

  bench('1MB', () => {
    brotliCompress(RANDOM_LARGE);
  });
});

describe('brotli compress (realistic)', () => {
  bench(`JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`, () => {
    brotliCompress(JSON_DATA);
  });

  bench(`text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`, () => {
    brotliCompress(TEXT_DATA);
  });
});

describe('brotli decompress (patterned)', () => {
  bench('150B', () => {
    brotliDecompress(SMALL_COMPRESSED);
  });

  bench('10KB', () => {
    brotliDecompress(MEDIUM_COMPRESSED);
  });

  bench('1MB', () => {
    brotliDecompress(LARGE_COMPRESSED);
  });
});

describe('brotli decompress (random)', () => {
  bench('150B', () => {
    brotliDecompress(RANDOM_SMALL_COMPRESSED);
  });

  bench('10KB', () => {
    brotliDecompress(RANDOM_MEDIUM_COMPRESSED);
  });

  bench('1MB', () => {
    brotliDecompress(RANDOM_LARGE_COMPRESSED);
  });
});

describe('brotli decompress (realistic)', () => {
  bench(`JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`, () => {
    brotliDecompress(JSON_COMPRESSED);
  });

  bench(`text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`, () => {
    brotliDecompress(TEXT_COMPRESSED);
  });
});
