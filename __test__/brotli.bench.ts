import { describe, test } from 'vitest';
import { brotliCompress, brotliDecompress } from '../index.js';
import {
  BENCH_OPTIONS,
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

// --- Names of the realistic data benchmarks ---
const JSON_NAME = `JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`;
const TEXT_NAME = `text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`;

describe('brotli compress (patterned)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      brotliCompress(SMALL);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      brotliCompress(MEDIUM);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      brotliCompress(LARGE);
    }).run(BENCH_OPTIONS);
  });
});

describe('brotli compress (random)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      brotliCompress(RANDOM_SMALL);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      brotliCompress(RANDOM_MEDIUM);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      brotliCompress(RANDOM_LARGE);
    }).run(BENCH_OPTIONS);
  });
});

describe('brotli compress (realistic)', () => {
  test(JSON_NAME, async ({ bench }) => {
    await bench(JSON_NAME, () => {
      brotliCompress(JSON_DATA);
    }).run(BENCH_OPTIONS);
  });

  test(TEXT_NAME, async ({ bench }) => {
    await bench(TEXT_NAME, () => {
      brotliCompress(TEXT_DATA);
    }).run(BENCH_OPTIONS);
  });
});

describe('brotli decompress (patterned)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      brotliDecompress(SMALL_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      brotliDecompress(MEDIUM_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      brotliDecompress(LARGE_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});

describe('brotli decompress (random)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      brotliDecompress(RANDOM_SMALL_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      brotliDecompress(RANDOM_MEDIUM_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      brotliDecompress(RANDOM_LARGE_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});

describe('brotli decompress (realistic)', () => {
  test(JSON_NAME, async ({ bench }) => {
    await bench(JSON_NAME, () => {
      brotliDecompress(JSON_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test(TEXT_NAME, async ({ bench }) => {
    await bench(TEXT_NAME, () => {
      brotliDecompress(TEXT_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});
