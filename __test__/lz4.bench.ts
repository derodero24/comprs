import { describe, test } from 'vitest';
import { lz4Compress, lz4Decompress } from '../index.js';
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
const SMALL_COMPRESSED = lz4Compress(SMALL);
const MEDIUM_COMPRESSED = lz4Compress(MEDIUM);
const LARGE_COMPRESSED = lz4Compress(LARGE);
const RANDOM_SMALL_COMPRESSED = lz4Compress(RANDOM_SMALL);
const RANDOM_MEDIUM_COMPRESSED = lz4Compress(RANDOM_MEDIUM);
const RANDOM_LARGE_COMPRESSED = lz4Compress(RANDOM_LARGE);
const JSON_COMPRESSED = lz4Compress(JSON_DATA);
const TEXT_COMPRESSED = lz4Compress(TEXT_DATA);

// --- Names of the realistic data benchmarks ---
const JSON_NAME = `JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`;
const TEXT_NAME = `text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`;

describe('lz4 compress (patterned)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      lz4Compress(SMALL);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      lz4Compress(MEDIUM);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      lz4Compress(LARGE);
    }).run(BENCH_OPTIONS);
  });
});

describe('lz4 compress (random)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      lz4Compress(RANDOM_SMALL);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      lz4Compress(RANDOM_MEDIUM);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      lz4Compress(RANDOM_LARGE);
    }).run(BENCH_OPTIONS);
  });
});

describe('lz4 compress (realistic)', () => {
  test(JSON_NAME, async ({ bench }) => {
    await bench(JSON_NAME, () => {
      lz4Compress(JSON_DATA);
    }).run(BENCH_OPTIONS);
  });

  test(TEXT_NAME, async ({ bench }) => {
    await bench(TEXT_NAME, () => {
      lz4Compress(TEXT_DATA);
    }).run(BENCH_OPTIONS);
  });
});

describe('lz4 decompress (patterned)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      lz4Decompress(SMALL_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      lz4Decompress(MEDIUM_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      lz4Decompress(LARGE_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});

describe('lz4 decompress (random)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      lz4Decompress(RANDOM_SMALL_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      lz4Decompress(RANDOM_MEDIUM_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      lz4Decompress(RANDOM_LARGE_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});

describe('lz4 decompress (realistic)', () => {
  test(JSON_NAME, async ({ bench }) => {
    await bench(JSON_NAME, () => {
      lz4Decompress(JSON_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test(TEXT_NAME, async ({ bench }) => {
    await bench(TEXT_NAME, () => {
      lz4Decompress(TEXT_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});
