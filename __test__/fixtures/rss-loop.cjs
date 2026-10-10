// Run by the RSS test in v8-owned-results.spec.ts, in a Node.js process of
// its own, so that the memory of the test worker does not count. Calls
// deflateDecompress on 1 MB of data in a synchronous loop, which never
// yields to the event loop, and prints how much the resident set size grew,
// in MiB, as JSON.
'use strict';

const { deflateCompress, deflateDecompress } = require('../../index.js');

const CALLS = 200;
const WARMUP = 20;
const SIZE = 1_000_000;

const input = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) {
  input[i] = i % 256;
}
const compressed = deflateCompress(input);

for (let i = 0; i < WARMUP; i++) {
  deflateDecompress(compressed);
}
const before = process.memoryUsage.rss();
for (let i = 0; i < CALLS; i++) {
  deflateDecompress(compressed);
}
const growth = (process.memoryUsage.rss() - before) / 2 ** 20;

process.stdout.write(JSON.stringify({ rssGrowthMiB: Math.round(growth) }));
