import { bench, describe } from 'vitest';
import { lz4Compress, lz4Decompress } from '../index.js';
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
const SMALL_COMPRESSED = lz4Compress(SMALL);
const MEDIUM_COMPRESSED = lz4Compress(MEDIUM);
const LARGE_COMPRESSED = lz4Compress(LARGE);
const RANDOM_SMALL_COMPRESSED = lz4Compress(RANDOM_SMALL);
const RANDOM_MEDIUM_COMPRESSED = lz4Compress(RANDOM_MEDIUM);
const RANDOM_LARGE_COMPRESSED = lz4Compress(RANDOM_LARGE);
const JSON_COMPRESSED = lz4Compress(JSON_DATA);
const TEXT_COMPRESSED = lz4Compress(TEXT_DATA);

describe('lz4 compress (patterned)', () => {
  bench('150B', () => {
    lz4Compress(SMALL);
  });

  bench('10KB', () => {
    lz4Compress(MEDIUM);
  });

  bench('1MB', () => {
    lz4Compress(LARGE);
  });
});

describe('lz4 compress (random)', () => {
  bench('150B', () => {
    lz4Compress(RANDOM_SMALL);
  });

  bench('10KB', () => {
    lz4Compress(RANDOM_MEDIUM);
  });

  bench('1MB', () => {
    lz4Compress(RANDOM_LARGE);
  });
});

describe('lz4 compress (realistic)', () => {
  bench(`JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`, () => {
    lz4Compress(JSON_DATA);
  });

  bench(`text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`, () => {
    lz4Compress(TEXT_DATA);
  });
});

describe('lz4 decompress (patterned)', () => {
  bench('150B', () => {
    lz4Decompress(SMALL_COMPRESSED);
  });

  bench('10KB', () => {
    lz4Decompress(MEDIUM_COMPRESSED);
  });

  bench('1MB', () => {
    lz4Decompress(LARGE_COMPRESSED);
  });
});

describe('lz4 decompress (random)', () => {
  bench('150B', () => {
    lz4Decompress(RANDOM_SMALL_COMPRESSED);
  });

  bench('10KB', () => {
    lz4Decompress(RANDOM_MEDIUM_COMPRESSED);
  });

  bench('1MB', () => {
    lz4Decompress(RANDOM_LARGE_COMPRESSED);
  });
});

describe('lz4 decompress (realistic)', () => {
  bench(`JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`, () => {
    lz4Decompress(JSON_COMPRESSED);
  });

  bench(`text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`, () => {
    lz4Decompress(TEXT_COMPRESSED);
  });
});
