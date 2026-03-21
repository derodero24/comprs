import { bench, describe } from 'vitest';
import { deflateCompress, deflateDecompress } from '../index.js';
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
const SMALL_COMPRESSED = deflateCompress(SMALL);
const MEDIUM_COMPRESSED = deflateCompress(MEDIUM);
const LARGE_COMPRESSED = deflateCompress(LARGE);
const RANDOM_SMALL_COMPRESSED = deflateCompress(RANDOM_SMALL);
const RANDOM_MEDIUM_COMPRESSED = deflateCompress(RANDOM_MEDIUM);
const RANDOM_LARGE_COMPRESSED = deflateCompress(RANDOM_LARGE);
const JSON_COMPRESSED = deflateCompress(JSON_DATA);
const TEXT_COMPRESSED = deflateCompress(TEXT_DATA);

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

describe('deflate compress (realistic)', () => {
  bench(`JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`, () => {
    deflateCompress(JSON_DATA);
  });

  bench(`text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`, () => {
    deflateCompress(TEXT_DATA);
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

describe('deflate decompress (realistic)', () => {
  bench(`JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`, () => {
    deflateDecompress(JSON_COMPRESSED);
  });

  bench(`text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`, () => {
    deflateDecompress(TEXT_COMPRESSED);
  });
});
