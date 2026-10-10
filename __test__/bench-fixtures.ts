import { Buffer } from 'node:buffer';
import type { BenchRunOptions } from 'vitest';

// --- Tinybench options for every benchmark ---
// The defaults of tinybench 2, which Vitest 4 used: at least half a second and
// 10 runs per benchmark, after a warmup of at least 100 ms and 5 runs.
// Tinybench 6, which Vitest 5 uses, defaults to at least a second and 64 runs,
// after a warmup of 250 ms and 16 runs, which would make `pnpm run bench` take
// twice as long, and the 1MB benchmarks of the slower libraries far longer.
// BENCH_SMOKE=1 runs each benchmark once, without warmup: CI checks that the
// benchmarks work without spending minutes measuring them.
export const BENCH_OPTIONS: BenchRunOptions =
  process.env['BENCH_SMOKE'] === '1'
    ? { time: 0, iterations: 1, warmup: false }
    : { time: 500, iterations: 10, warmupTime: 100, warmupIterations: 5 };

// --- Deterministic pseudo-random data generator ---
// Uses a linear congruential generator for reproducible benchmark inputs:
// randomBytes would give every run different data to compress. Each byte is
// the top 8 bits of the 32-bit state: the low k bits of the state repeat
// every 2^k steps, so the low byte would repeat every 256 bytes and compress
// almost as well as the patterned data.
// Matches deterministic_bytes in crates/bench/src/lib.rs.
export const deterministicBytes = (size: number, seed: number): Buffer => {
  const out = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
};

// --- Patterned data (compressible) ---
export const SMALL = Buffer.from('Hello, comprs! '.repeat(10));
export const MEDIUM = Buffer.alloc(10_000);
for (let i = 0; i < MEDIUM.length; i++) MEDIUM[i] = i % 256;
export const LARGE = Buffer.alloc(1_000_000);
for (let i = 0; i < LARGE.length; i++) LARGE[i] = i % 256;

// --- Deterministic pseudo-random data (incompressible) ---
export const RANDOM_SMALL = deterministicBytes(150, 0x1234);
export const RANDOM_MEDIUM = deterministicBytes(10_000, 0x5678);
export const RANDOM_LARGE = deterministicBytes(1_000_000, 0x9abc);

// --- Realistic data ---
// JSON_DATA matches json_84kb in crates/bench/src/lib.rs.
export const JSON_DATA = Buffer.from(
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

export const TEXT_DATA = Buffer.from(
  `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. `.repeat(
    200,
  ),
);
