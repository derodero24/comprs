import { randomBytes } from 'node:crypto';
import { deflateRawSync as nodeDeflate, inflateRawSync as nodeInflate } from 'node:zlib';
import { deflateSync, inflateSync } from 'fflate';
import pako from 'pako';
import { bench, describe } from 'vitest';
import { deflateCompress, deflateDecompress } from '../index.js';

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
const SMALL_ZFLATE = deflateCompress(SMALL);
const SMALL_PAKO = Buffer.from(pako.deflateRaw(SMALL));
const SMALL_FFLATE = Buffer.from(deflateSync(SMALL));
const SMALL_NODE = nodeDeflate(SMALL);

const MEDIUM_ZFLATE = deflateCompress(MEDIUM);
const MEDIUM_PAKO = Buffer.from(pako.deflateRaw(MEDIUM));
const MEDIUM_FFLATE = Buffer.from(deflateSync(MEDIUM));
const MEDIUM_NODE = nodeDeflate(MEDIUM);

const LARGE_ZFLATE = deflateCompress(LARGE);
const LARGE_PAKO = Buffer.from(pako.deflateRaw(LARGE));
const LARGE_FFLATE = Buffer.from(deflateSync(LARGE));
const LARGE_NODE = nodeDeflate(LARGE);

const RANDOM_SMALL_ZFLATE = deflateCompress(RANDOM_SMALL);
const RANDOM_SMALL_PAKO = Buffer.from(pako.deflateRaw(RANDOM_SMALL));
const RANDOM_SMALL_FFLATE = Buffer.from(deflateSync(RANDOM_SMALL));
const RANDOM_SMALL_NODE = nodeDeflate(RANDOM_SMALL);

const RANDOM_MEDIUM_ZFLATE = deflateCompress(RANDOM_MEDIUM);
const RANDOM_MEDIUM_PAKO = Buffer.from(pako.deflateRaw(RANDOM_MEDIUM));
const RANDOM_MEDIUM_FFLATE = Buffer.from(deflateSync(RANDOM_MEDIUM));
const RANDOM_MEDIUM_NODE = nodeDeflate(RANDOM_MEDIUM);

const RANDOM_LARGE_ZFLATE = deflateCompress(RANDOM_LARGE);
const RANDOM_LARGE_PAKO = Buffer.from(pako.deflateRaw(RANDOM_LARGE));
const RANDOM_LARGE_FFLATE = Buffer.from(deflateSync(RANDOM_LARGE));
const RANDOM_LARGE_NODE = nodeDeflate(RANDOM_LARGE);

// =====================================================
// Compression benchmarks
// =====================================================

describe('deflate compress - 150B patterned', () => {
  bench('zflate', () => {
    deflateCompress(SMALL);
  });
  bench('pako', () => {
    pako.deflateRaw(SMALL);
  });
  bench('fflate', () => {
    deflateSync(SMALL);
  });
  bench('node:zlib', () => {
    nodeDeflate(SMALL);
  });
});

describe('deflate compress - 10KB patterned', () => {
  bench('zflate', () => {
    deflateCompress(MEDIUM);
  });
  bench('pako', () => {
    pako.deflateRaw(MEDIUM);
  });
  bench('fflate', () => {
    deflateSync(MEDIUM);
  });
  bench('node:zlib', () => {
    nodeDeflate(MEDIUM);
  });
});

describe('deflate compress - 1MB patterned', () => {
  bench('zflate', () => {
    deflateCompress(LARGE);
  });
  bench('pako', () => {
    pako.deflateRaw(LARGE);
  });
  bench('fflate', () => {
    deflateSync(LARGE);
  });
  bench('node:zlib', () => {
    nodeDeflate(LARGE);
  });
});

describe('deflate compress - 150B random', () => {
  bench('zflate', () => {
    deflateCompress(RANDOM_SMALL);
  });
  bench('pako', () => {
    pako.deflateRaw(RANDOM_SMALL);
  });
  bench('fflate', () => {
    deflateSync(RANDOM_SMALL);
  });
  bench('node:zlib', () => {
    nodeDeflate(RANDOM_SMALL);
  });
});

describe('deflate compress - 10KB random', () => {
  bench('zflate', () => {
    deflateCompress(RANDOM_MEDIUM);
  });
  bench('pako', () => {
    pako.deflateRaw(RANDOM_MEDIUM);
  });
  bench('fflate', () => {
    deflateSync(RANDOM_MEDIUM);
  });
  bench('node:zlib', () => {
    nodeDeflate(RANDOM_MEDIUM);
  });
});

describe('deflate compress - 1MB random', () => {
  bench('zflate', () => {
    deflateCompress(RANDOM_LARGE);
  });
  bench('pako', () => {
    pako.deflateRaw(RANDOM_LARGE);
  });
  bench('fflate', () => {
    deflateSync(RANDOM_LARGE);
  });
  bench('node:zlib', () => {
    nodeDeflate(RANDOM_LARGE);
  });
});

// =====================================================
// Decompression benchmarks
// =====================================================

describe('deflate decompress - 150B patterned', () => {
  bench('zflate', () => {
    deflateDecompress(SMALL_ZFLATE);
  });
  bench('pako', () => {
    pako.inflateRaw(SMALL_PAKO);
  });
  bench('fflate', () => {
    inflateSync(SMALL_FFLATE);
  });
  bench('node:zlib', () => {
    nodeInflate(SMALL_NODE);
  });
});

describe('deflate decompress - 10KB patterned', () => {
  bench('zflate', () => {
    deflateDecompress(MEDIUM_ZFLATE);
  });
  bench('pako', () => {
    pako.inflateRaw(MEDIUM_PAKO);
  });
  bench('fflate', () => {
    inflateSync(MEDIUM_FFLATE);
  });
  bench('node:zlib', () => {
    nodeInflate(MEDIUM_NODE);
  });
});

describe('deflate decompress - 1MB patterned', () => {
  bench('zflate', () => {
    deflateDecompress(LARGE_ZFLATE);
  });
  bench('pako', () => {
    pako.inflateRaw(LARGE_PAKO);
  });
  bench('fflate', () => {
    inflateSync(LARGE_FFLATE);
  });
  bench('node:zlib', () => {
    nodeInflate(LARGE_NODE);
  });
});

describe('deflate decompress - 150B random', () => {
  bench('zflate', () => {
    deflateDecompress(RANDOM_SMALL_ZFLATE);
  });
  bench('pako', () => {
    pako.inflateRaw(RANDOM_SMALL_PAKO);
  });
  bench('fflate', () => {
    inflateSync(RANDOM_SMALL_FFLATE);
  });
  bench('node:zlib', () => {
    nodeInflate(RANDOM_SMALL_NODE);
  });
});

describe('deflate decompress - 10KB random', () => {
  bench('zflate', () => {
    deflateDecompress(RANDOM_MEDIUM_ZFLATE);
  });
  bench('pako', () => {
    pako.inflateRaw(RANDOM_MEDIUM_PAKO);
  });
  bench('fflate', () => {
    inflateSync(RANDOM_MEDIUM_FFLATE);
  });
  bench('node:zlib', () => {
    nodeInflate(RANDOM_MEDIUM_NODE);
  });
});

describe('deflate decompress - 1MB random', () => {
  bench('zflate', () => {
    deflateDecompress(RANDOM_LARGE_ZFLATE);
  });
  bench('pako', () => {
    pako.inflateRaw(RANDOM_LARGE_PAKO);
  });
  bench('fflate', () => {
    inflateSync(RANDOM_LARGE_FFLATE);
  });
  bench('node:zlib', () => {
    nodeInflate(RANDOM_LARGE_NODE);
  });
});
