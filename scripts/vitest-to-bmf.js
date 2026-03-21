#!/usr/bin/env node

// Converts vitest bench --outputJson output to Bencher Metric Format (BMF) JSON.
// BMF spec: https://bencher.dev/docs/reference/bencher-metric-format/

const fs = require('node:fs');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/vitest-to-bmf.js <input.json> [output.json]');
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
const bmf = {};

for (const file of input.files) {
  for (const group of file.groups) {
    for (const bench of group.benchmarks) {
      const name = `${group.fullName} > ${bench.name}`;
      bmf[name] = {
        latency: {
          value: bench.mean * 1e6, // ms -> ns
          lower_value: bench.min * 1e6,
          upper_value: bench.max * 1e6,
        },
        throughput: {
          value: bench.hz,
        },
      };
    }
  }
}

const outputPath = process.argv[3] || '/dev/stdout';
fs.writeFileSync(outputPath, JSON.stringify(bmf, null, 2));
