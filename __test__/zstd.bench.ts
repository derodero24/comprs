import { bench, describe } from 'vitest';
import { zstdCompress, zstdDecompress } from '../index.js';
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
const SMALL_COMPRESSED = zstdCompress(SMALL);
const MEDIUM_COMPRESSED = zstdCompress(MEDIUM);
const LARGE_COMPRESSED = zstdCompress(LARGE);
const RANDOM_SMALL_COMPRESSED = zstdCompress(RANDOM_SMALL);
const RANDOM_MEDIUM_COMPRESSED = zstdCompress(RANDOM_MEDIUM);
const RANDOM_LARGE_COMPRESSED = zstdCompress(RANDOM_LARGE);
const JSON_COMPRESSED = zstdCompress(JSON_DATA);
const TEXT_COMPRESSED = zstdCompress(TEXT_DATA);

describe('zstd compress (patterned)', () => {
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

describe('zstd compress (random)', () => {
  bench('150B', () => {
    zstdCompress(RANDOM_SMALL);
  });

  bench('10KB', () => {
    zstdCompress(RANDOM_MEDIUM);
  });

  bench('1MB', () => {
    zstdCompress(RANDOM_LARGE);
  });
});

describe('zstd compress (realistic)', () => {
  bench(`JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`, () => {
    zstdCompress(JSON_DATA);
  });

  bench(`text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`, () => {
    zstdCompress(TEXT_DATA);
  });
});

describe('zstd decompress (patterned)', () => {
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

describe('zstd decompress (random)', () => {
  bench('150B', () => {
    zstdDecompress(RANDOM_SMALL_COMPRESSED);
  });

  bench('10KB', () => {
    zstdDecompress(RANDOM_MEDIUM_COMPRESSED);
  });

  bench('1MB', () => {
    zstdDecompress(RANDOM_LARGE_COMPRESSED);
  });
});

describe('zstd decompress (realistic)', () => {
  bench(`JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`, () => {
    zstdDecompress(JSON_COMPRESSED);
  });

  bench(`text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`, () => {
    zstdDecompress(TEXT_COMPRESSED);
  });
});
