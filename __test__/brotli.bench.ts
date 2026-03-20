import { randomBytes } from 'node:crypto';
import {
  brotliCompressSync as nodeBrotliCompress,
  brotliDecompressSync as nodeBrotliDecompress,
} from 'node:zlib';
import { bench, describe } from 'vitest';
import { brotliCompress, brotliDecompress } from '../index.js';

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

// --- Pre-compressed data for decompression benchmarks ---
const SMALL_ZFLATE = brotliCompress(SMALL);
const SMALL_NODE = nodeBrotliCompress(SMALL);

const MEDIUM_ZFLATE = brotliCompress(MEDIUM);
const MEDIUM_NODE = nodeBrotliCompress(MEDIUM);

const LARGE_ZFLATE = brotliCompress(LARGE);
const LARGE_NODE = nodeBrotliCompress(LARGE);

const RANDOM_SMALL_ZFLATE = brotliCompress(RANDOM_SMALL);
const RANDOM_SMALL_NODE = nodeBrotliCompress(RANDOM_SMALL);

const RANDOM_MEDIUM_ZFLATE = brotliCompress(RANDOM_MEDIUM);
const RANDOM_MEDIUM_NODE = nodeBrotliCompress(RANDOM_MEDIUM);

const RANDOM_LARGE_ZFLATE = brotliCompress(RANDOM_LARGE);
const RANDOM_LARGE_NODE = nodeBrotliCompress(RANDOM_LARGE);

// =====================================================
// Compression benchmarks
// =====================================================

describe('brotli compress - 150B patterned', () => {
  bench('zflate', () => {
    brotliCompress(SMALL);
  });
  bench('node:zlib', () => {
    nodeBrotliCompress(SMALL);
  });
});

describe('brotli compress - 10KB patterned', () => {
  bench('zflate', () => {
    brotliCompress(MEDIUM);
  });
  bench('node:zlib', () => {
    nodeBrotliCompress(MEDIUM);
  });
});

describe('brotli compress - 1MB patterned', () => {
  bench('zflate', () => {
    brotliCompress(LARGE);
  });
  bench('node:zlib', () => {
    nodeBrotliCompress(LARGE);
  });
});

describe('brotli compress - 150B random', () => {
  bench('zflate', () => {
    brotliCompress(RANDOM_SMALL);
  });
  bench('node:zlib', () => {
    nodeBrotliCompress(RANDOM_SMALL);
  });
});

describe('brotli compress - 10KB random', () => {
  bench('zflate', () => {
    brotliCompress(RANDOM_MEDIUM);
  });
  bench('node:zlib', () => {
    nodeBrotliCompress(RANDOM_MEDIUM);
  });
});

describe('brotli compress - 1MB random', () => {
  bench('zflate', () => {
    brotliCompress(RANDOM_LARGE);
  });
  bench('node:zlib', () => {
    nodeBrotliCompress(RANDOM_LARGE);
  });
});

// =====================================================
// Decompression benchmarks
// =====================================================

describe('brotli decompress - 150B patterned', () => {
  bench('zflate', () => {
    brotliDecompress(SMALL_ZFLATE);
  });
  bench('node:zlib', () => {
    nodeBrotliDecompress(SMALL_NODE);
  });
});

describe('brotli decompress - 10KB patterned', () => {
  bench('zflate', () => {
    brotliDecompress(MEDIUM_ZFLATE);
  });
  bench('node:zlib', () => {
    nodeBrotliDecompress(MEDIUM_NODE);
  });
});

describe('brotli decompress - 1MB patterned', () => {
  bench('zflate', () => {
    brotliDecompress(LARGE_ZFLATE);
  });
  bench('node:zlib', () => {
    nodeBrotliDecompress(LARGE_NODE);
  });
});

describe('brotli decompress - 150B random', () => {
  bench('zflate', () => {
    brotliDecompress(RANDOM_SMALL_ZFLATE);
  });
  bench('node:zlib', () => {
    nodeBrotliDecompress(RANDOM_SMALL_NODE);
  });
});

describe('brotli decompress - 10KB random', () => {
  bench('zflate', () => {
    brotliDecompress(RANDOM_MEDIUM_ZFLATE);
  });
  bench('node:zlib', () => {
    nodeBrotliDecompress(RANDOM_MEDIUM_NODE);
  });
});

describe('brotli decompress - 1MB random', () => {
  bench('zflate', () => {
    brotliDecompress(RANDOM_LARGE_ZFLATE);
  });
  bench('node:zlib', () => {
    nodeBrotliDecompress(RANDOM_LARGE_NODE);
  });
});
