import { bench, describe } from 'vitest';
import { brotliCompress, brotliDecompress, zstdCompress, zstdDecompress } from '../index.js';

// --- Patterned data (compressible) ---
const SMALL = Buffer.from('Hello, zflate! '.repeat(10));
const MEDIUM = Buffer.alloc(10_000);
for (let i = 0; i < MEDIUM.length; i++) MEDIUM[i] = i % 256;
const LARGE = Buffer.alloc(1_000_000);
for (let i = 0; i < LARGE.length; i++) LARGE[i] = i % 256;

// --- Deterministic pseudo-random data (incompressible) ---
// Uses a linear congruential generator for reproducible benchmark inputs,
// avoiding CodSpeed instruction count variance from non-deterministic randomBytes.
const deterministicBytes = (size: number, seed: number): Buffer => {
  const out = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (1664525 * x + 1013904223) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
};
const RANDOM_SMALL = deterministicBytes(150, 0x1234);
const RANDOM_MEDIUM = deterministicBytes(10_000, 0x5678);
const RANDOM_LARGE = deterministicBytes(1_000_000, 0x9abc);

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

// --- Brotli pre-compressed data ---
const BROTLI_SMALL_COMPRESSED = brotliCompress(SMALL);
const BROTLI_MEDIUM_COMPRESSED = brotliCompress(MEDIUM);
const BROTLI_LARGE_COMPRESSED = brotliCompress(LARGE);
const BROTLI_RANDOM_SMALL_COMPRESSED = brotliCompress(RANDOM_SMALL);
const BROTLI_RANDOM_MEDIUM_COMPRESSED = brotliCompress(RANDOM_MEDIUM);
const BROTLI_RANDOM_LARGE_COMPRESSED = brotliCompress(RANDOM_LARGE);
const BROTLI_JSON_COMPRESSED = brotliCompress(JSON_DATA);
const BROTLI_TEXT_COMPRESSED = brotliCompress(TEXT_DATA);

describe('brotli compress (patterned)', () => {
  bench('150B', () => {
    brotliCompress(SMALL);
  });

  bench('10KB', () => {
    brotliCompress(MEDIUM);
  });

  bench('1MB', () => {
    brotliCompress(LARGE);
  });
});

describe('brotli compress (random)', () => {
  bench('150B', () => {
    brotliCompress(RANDOM_SMALL);
  });

  bench('10KB', () => {
    brotliCompress(RANDOM_MEDIUM);
  });

  bench('1MB', () => {
    brotliCompress(RANDOM_LARGE);
  });
});

describe('brotli compress (realistic)', () => {
  bench(`JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`, () => {
    brotliCompress(JSON_DATA);
  });

  bench(`text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`, () => {
    brotliCompress(TEXT_DATA);
  });
});

describe('brotli decompress (patterned)', () => {
  bench('150B', () => {
    brotliDecompress(BROTLI_SMALL_COMPRESSED);
  });

  bench('10KB', () => {
    brotliDecompress(BROTLI_MEDIUM_COMPRESSED);
  });

  bench('1MB', () => {
    brotliDecompress(BROTLI_LARGE_COMPRESSED);
  });
});

describe('brotli decompress (random)', () => {
  bench('150B', () => {
    brotliDecompress(BROTLI_RANDOM_SMALL_COMPRESSED);
  });

  bench('10KB', () => {
    brotliDecompress(BROTLI_RANDOM_MEDIUM_COMPRESSED);
  });

  bench('1MB', () => {
    brotliDecompress(BROTLI_RANDOM_LARGE_COMPRESSED);
  });
});

describe('brotli decompress (realistic)', () => {
  bench(`JSON ${(JSON_DATA.length / 1024).toFixed(0)}KB`, () => {
    brotliDecompress(BROTLI_JSON_COMPRESSED);
  });

  bench(`text ${(TEXT_DATA.length / 1024).toFixed(0)}KB`, () => {
    brotliDecompress(BROTLI_TEXT_COMPRESSED);
  });
});
