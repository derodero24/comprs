import { describe, test } from 'vitest';
import { gzipCompress, gzipDecompress } from '../index.js';
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
const SMALL_COMPRESSED = gzipCompress(SMALL);
const MEDIUM_COMPRESSED = gzipCompress(MEDIUM);
const LARGE_COMPRESSED = gzipCompress(LARGE);
const RANDOM_SMALL_COMPRESSED = gzipCompress(RANDOM_SMALL);
const RANDOM_MEDIUM_COMPRESSED = gzipCompress(RANDOM_MEDIUM);
const RANDOM_LARGE_COMPRESSED = gzipCompress(RANDOM_LARGE);
const JSON_COMPRESSED = gzipCompress(JSON_DATA);
const TEXT_COMPRESSED = gzipCompress(TEXT_DATA);

// --- Names of the realistic data benchmarks ---
const JSON_NAME = `JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`;
const TEXT_NAME = `text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`;

describe('gzip compress (patterned)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      gzipCompress(SMALL);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      gzipCompress(MEDIUM);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      gzipCompress(LARGE);
    }).run(BENCH_OPTIONS);
  });
});

describe('gzip compress (random)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      gzipCompress(RANDOM_SMALL);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      gzipCompress(RANDOM_MEDIUM);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      gzipCompress(RANDOM_LARGE);
    }).run(BENCH_OPTIONS);
  });
});

describe('gzip compress (realistic)', () => {
  test(JSON_NAME, async ({ bench }) => {
    await bench(JSON_NAME, () => {
      gzipCompress(JSON_DATA);
    }).run(BENCH_OPTIONS);
  });

  test(TEXT_NAME, async ({ bench }) => {
    await bench(TEXT_NAME, () => {
      gzipCompress(TEXT_DATA);
    }).run(BENCH_OPTIONS);
  });
});

describe('gzip decompress (patterned)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      gzipDecompress(SMALL_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      gzipDecompress(MEDIUM_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      gzipDecompress(LARGE_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});

describe('gzip decompress (random)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      gzipDecompress(RANDOM_SMALL_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      gzipDecompress(RANDOM_MEDIUM_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      gzipDecompress(RANDOM_LARGE_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});

describe('gzip decompress (realistic)', () => {
  test(JSON_NAME, async ({ bench }) => {
    await bench(JSON_NAME, () => {
      gzipDecompress(JSON_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test(TEXT_NAME, async ({ bench }) => {
    await bench(TEXT_NAME, () => {
      gzipDecompress(TEXT_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});
