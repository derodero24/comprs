import { randomBytes } from 'node:crypto';
import { bench, describe } from 'vitest';
import { zstdCompress, zstdDecompress } from '../index.js';

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
