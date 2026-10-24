// Run by the RSS tests in v8-owned-results.spec.ts, in a Node.js process of
// its own, so that the memory of the test worker does not count. Calls
// deflateDecompress on 1 MB of data, or with the argument `zstd` or `lz4`
// zstdDecompress or lz4Decompress on 4 MiB, and with `next-zstd` or
// `next-lz4` decompressSync() of the unified API on 4 MiB of that format,
// in a synchronous loop, which never yields to the event loop, and prints
// how much the resident set size grew, in MiB, as JSON.
'use strict';

const {
  deflateCompress,
  deflateDecompress,
  lz4Compress,
  lz4Decompress,
  zstdCompress,
  zstdDecompress,
} = require('../../index.js');
const { decompressSync } = require('../../next/index.js');

const CALLS = 200;
const WARMUP = 20;

/**
 * The compression function and the decompression function of each argument.
 * @type {Record<string, [(data: Buffer) => Uint8Array, (data: Buffer) => Uint8Array, number]>}
 */
const CASES = {
  deflate: [deflateCompress, deflateDecompress, 1_000_000],
  zstd: [zstdCompress, zstdDecompress, 4 * 1024 * 1024],
  lz4: [lz4Compress, lz4Decompress, 4 * 1024 * 1024],
  'next-zstd': [zstdCompress, (data) => decompressSync(data, { format: 'zstd' }), 4 * 1024 * 1024],
  'next-lz4': [lz4Compress, (data) => decompressSync(data, { format: 'lz4' }), 4 * 1024 * 1024],
};
const selected = CASES[process.argv[2] ?? 'deflate'];
if (selected === undefined) {
  throw new Error(`unknown case ${process.argv[2]}`);
}
const [compress, decompress, size] = selected;

const input = Buffer.alloc(size);
for (let i = 0; i < size; i++) {
  input[i] = i % 256;
}
const compressed = Buffer.from(compress(input));

for (let i = 0; i < WARMUP; i++) {
  decompress(compressed);
}
const before = process.memoryUsage.rss();
for (let i = 0; i < CALLS; i++) {
  decompress(compressed);
}
const growth = (process.memoryUsage.rss() - before) / 2 ** 20;

process.stdout.write(JSON.stringify({ rssGrowthMiB: Math.round(growth) }));
