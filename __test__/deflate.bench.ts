import { describe, test } from 'vitest';
import { deflateCompress, deflateDecompress } from '../index.js';
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
const SMALL_COMPRESSED = deflateCompress(SMALL);
const MEDIUM_COMPRESSED = deflateCompress(MEDIUM);
const LARGE_COMPRESSED = deflateCompress(LARGE);
const RANDOM_SMALL_COMPRESSED = deflateCompress(RANDOM_SMALL);
const RANDOM_MEDIUM_COMPRESSED = deflateCompress(RANDOM_MEDIUM);
const RANDOM_LARGE_COMPRESSED = deflateCompress(RANDOM_LARGE);
const JSON_COMPRESSED = deflateCompress(JSON_DATA);
const TEXT_COMPRESSED = deflateCompress(TEXT_DATA);

// --- Names of the realistic data benchmarks ---
const JSON_NAME = `JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`;
const TEXT_NAME = `text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`;

describe('deflate compress (patterned)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      deflateCompress(SMALL);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      deflateCompress(MEDIUM);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      deflateCompress(LARGE);
    }).run(BENCH_OPTIONS);
  });
});

describe('deflate compress (random)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      deflateCompress(RANDOM_SMALL);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      deflateCompress(RANDOM_MEDIUM);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      deflateCompress(RANDOM_LARGE);
    }).run(BENCH_OPTIONS);
  });
});

describe('deflate compress (realistic)', () => {
  test(JSON_NAME, async ({ bench }) => {
    await bench(JSON_NAME, () => {
      deflateCompress(JSON_DATA);
    }).run(BENCH_OPTIONS);
  });

  test(TEXT_NAME, async ({ bench }) => {
    await bench(TEXT_NAME, () => {
      deflateCompress(TEXT_DATA);
    }).run(BENCH_OPTIONS);
  });
});

describe('deflate decompress (patterned)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      deflateDecompress(SMALL_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      deflateDecompress(MEDIUM_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      deflateDecompress(LARGE_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});

describe('deflate decompress (random)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      deflateDecompress(RANDOM_SMALL_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      deflateDecompress(RANDOM_MEDIUM_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      deflateDecompress(RANDOM_LARGE_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});

describe('deflate decompress (realistic)', () => {
  test(JSON_NAME, async ({ bench }) => {
    await bench(JSON_NAME, () => {
      deflateDecompress(JSON_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test(TEXT_NAME, async ({ bench }) => {
    await bench(TEXT_NAME, () => {
      deflateDecompress(TEXT_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});
