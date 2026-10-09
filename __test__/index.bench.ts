import { randomBytes } from 'node:crypto';
import { describe, test } from 'vitest';
import { zstdCompress, zstdDecompress } from '../index.js';
import { BENCH_OPTIONS } from './bench-fixtures.js';

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

// --- Realistic data ---
const JSON_DATA = Buffer.from(
  JSON.stringify(
    Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      email: `user${i}@example.com`,
      active: i % 3 !== 0,
      score: Math.round(Math.sin(i) * 1000) / 10,
    })),
  ),
);

const TEXT_DATA = Buffer.from(
  `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. `.repeat(
    200,
  ),
);

// Pre-compress for decompression benchmarks
const SMALL_COMPRESSED = zstdCompress(SMALL);
const MEDIUM_COMPRESSED = zstdCompress(MEDIUM);
const LARGE_COMPRESSED = zstdCompress(LARGE);
const RANDOM_SMALL_COMPRESSED = zstdCompress(RANDOM_SMALL);
const RANDOM_MEDIUM_COMPRESSED = zstdCompress(RANDOM_MEDIUM);
const RANDOM_LARGE_COMPRESSED = zstdCompress(RANDOM_LARGE);
const JSON_COMPRESSED = zstdCompress(JSON_DATA);
const TEXT_COMPRESSED = zstdCompress(TEXT_DATA);

// Names of the realistic data benchmarks
const JSON_NAME = `JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`;
const TEXT_NAME = `text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`;

describe('zstd compress (patterned)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      zstdCompress(SMALL);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      zstdCompress(MEDIUM);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      zstdCompress(LARGE);
    }).run(BENCH_OPTIONS);
  });
});

describe('zstd compress (random)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      zstdCompress(RANDOM_SMALL);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      zstdCompress(RANDOM_MEDIUM);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      zstdCompress(RANDOM_LARGE);
    }).run(BENCH_OPTIONS);
  });
});

describe('zstd compress (realistic)', () => {
  test(JSON_NAME, async ({ bench }) => {
    await bench(JSON_NAME, () => {
      zstdCompress(JSON_DATA);
    }).run(BENCH_OPTIONS);
  });

  test(TEXT_NAME, async ({ bench }) => {
    await bench(TEXT_NAME, () => {
      zstdCompress(TEXT_DATA);
    }).run(BENCH_OPTIONS);
  });
});

describe('zstd decompress (patterned)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      zstdDecompress(SMALL_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      zstdDecompress(MEDIUM_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      zstdDecompress(LARGE_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});

describe('zstd decompress (random)', () => {
  test('150B', async ({ bench }) => {
    await bench('150B', () => {
      zstdDecompress(RANDOM_SMALL_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('10KB', async ({ bench }) => {
    await bench('10KB', () => {
      zstdDecompress(RANDOM_MEDIUM_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test('1MB', async ({ bench }) => {
    await bench('1MB', () => {
      zstdDecompress(RANDOM_LARGE_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});

describe('zstd decompress (realistic)', () => {
  test(JSON_NAME, async ({ bench }) => {
    await bench(JSON_NAME, () => {
      zstdDecompress(JSON_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });

  test(TEXT_NAME, async ({ bench }) => {
    await bench(TEXT_NAME, () => {
      zstdDecompress(TEXT_COMPRESSED);
    }).run(BENCH_OPTIONS);
  });
});
