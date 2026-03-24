import { bench, describe } from 'vitest';
import { gzipCompress, gzipDecompress } from '../index.js';
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
const SMALL_COMPRESSED = gzipCompress(SMALL);
const MEDIUM_COMPRESSED = gzipCompress(MEDIUM);
const LARGE_COMPRESSED = gzipCompress(LARGE);
const RANDOM_SMALL_COMPRESSED = gzipCompress(RANDOM_SMALL);
const RANDOM_MEDIUM_COMPRESSED = gzipCompress(RANDOM_MEDIUM);
const RANDOM_LARGE_COMPRESSED = gzipCompress(RANDOM_LARGE);
const JSON_COMPRESSED = gzipCompress(JSON_DATA);
const TEXT_COMPRESSED = gzipCompress(TEXT_DATA);

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

describe('gzip compress (realistic)', () => {
  bench(`JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`, () => {
    gzipCompress(JSON_DATA);
  });

  bench(`text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`, () => {
    gzipCompress(TEXT_DATA);
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

describe('gzip decompress (realistic)', () => {
  bench(`JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`, () => {
    gzipDecompress(JSON_COMPRESSED);
  });

  bench(`text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`, () => {
    gzipDecompress(TEXT_COMPRESSED);
  });
});
