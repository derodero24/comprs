// Run by the RSS tests in v8-owned-results.spec.ts, in a Node.js process of
// its own, so that the memory of the test worker does not count. Calls
// deflateDecompress on 1 MB of data, with the argument `zstd`
// zstdDecompress on 4 MiB, or with `next-zstd` decompressSync() of the
// unified API on 4 MiB of zstd data, in a synchronous loop, which never
// yields to the event loop, and prints how much the resident set size grew,
// in MiB, as JSON.
'use strict';

const {
  deflateCompress,
  deflateDecompress,
  zstdCompress,
  zstdDecompress,
} = require('../../index.js');
const { decompressSync } = require('../../next/index.js');

const CALLS = 200;
const WARMUP = 20;
const next = process.argv[2] === 'next-zstd';
const zstd = next || process.argv[2] === 'zstd';
const SIZE = zstd ? 4 * 1024 * 1024 : 1_000_000;

const input = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) {
  input[i] = i % 256;
}
const compressed = zstd ? zstdCompress(input) : deflateCompress(input);
const decompress = next
  ? (/** @type {Buffer} */ data) => decompressSync(data, { format: 'zstd' })
  : zstd
    ? zstdDecompress
    : deflateDecompress;

for (let i = 0; i < WARMUP; i++) {
  decompress(compressed);
}
const before = process.memoryUsage.rss();
for (let i = 0; i < CALLS; i++) {
  decompress(compressed);
}
const growth = (process.memoryUsage.rss() - before) / 2 ** 20;

process.stdout.write(JSON.stringify({ rssGrowthMiB: Math.round(growth) }));
