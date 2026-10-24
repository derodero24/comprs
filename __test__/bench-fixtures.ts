import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Bench, type BenchRegistration, type BenchRunOptions, test } from 'vitest';

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
for (let i = 0; i < MEDIUM.length; i++) {
  MEDIUM[i] = i % 256;
}
export const LARGE = Buffer.alloc(1_000_000);
for (let i = 0; i < LARGE.length; i++) {
  LARGE[i] = i % 256;
}

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

// --- Comparisons (*.compare.bench.ts) ---
// scripts/bench-report.mjs runs the comparisons and writes their results into
// the README. Every library in a comparison runs at the same settings.

/** A benchmark input, with the label that names it in the tests and the README. */
export interface BenchInput {
  readonly label: string;
  readonly data: Buffer;
}

/** The inputs of the comparisons. */
export const INPUTS: readonly BenchInput[] = [
  { label: 'text 150B', data: SMALL },
  { label: 'JSON 84KB', data: JSON_DATA },
  { label: 'text 45KB', data: TEXT_DATA },
  { label: 'random 10KB', data: RANDOM_MEDIUM },
  { label: 'random 1MB', data: RANDOM_LARGE },
  { label: 'patterned 1MB', data: LARGE },
];

/**
 * Records the input length and the compressed sizes of a group of benchmarks,
 * such as 'gzip level 6 - JSON 84KB', for scripts/bench-report.mjs, which
 * computes the speeds in MB/s and the compression ratios from them. Merges
 * them into the JSON file that COMPRS_BENCH_SIZES names; does nothing without
 * it. Vitest runs one benchmark file at a time, so two files never write the
 * file at once.
 */
export function recordSizes(
  group: string,
  inputLength: number,
  sizes: Readonly<Record<string, number>>,
): void {
  const file = process.env['COMPRS_BENCH_SIZES'];
  if (file === undefined || file === '') {
    return;
  }
  const recorded: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (typeof recorded !== 'object' || recorded === null || Array.isArray(recorded)) {
    throw new Error(`${file} does not hold a JSON object`);
  }
  writeFileSync(
    file,
    `${JSON.stringify({ ...recorded, [group]: { inputLength, sizes } }, null, 2)}\n`,
  );
}

/** A library's functions for one format, at the settings of a comparison. */
export interface Library {
  readonly name: string;
  readonly compress: (data: Buffer) => Uint8Array;
  readonly decompress: (data: Uint8Array) => Uint8Array;
}

/** Options of {@link compareLibraries}. */
export interface CompareOptions {
  /** The inputs to compare the libraries on: INPUTS by default. */
  readonly inputs?: readonly BenchInput[];
  /**
   * Whether each library decompresses its own output, as libraries of
   * different formats must. By default, every library decompresses the output
   * of the first one, comprs, so that only the decoders differ.
   */
  readonly ownOutput?: boolean;
}

/**
 * Compares the libraries on each input, in a test named
 * `<format> compress <setting> - <input label>` and one named
 * `<format> decompress <setting> - <input label>`, and records the compressed
 * sizes as `<format> <setting> - <input label>`. scripts/bench-report.mjs
 * finds the results by these names.
 */
export function compareLibraries(
  format: string,
  setting: string,
  libraries: readonly Library[],
  { inputs = INPUTS, ownOutput = false }: CompareOptions = {},
): void {
  for (const { label, data } of inputs) {
    const group = `${format} ${setting} - ${label}`;
    const outputs = libraries.map((library) => ({ library, output: library.compress(data) }));
    const first = outputs[0];
    if (first === undefined) {
      throw new Error(`${group}: no library to compare`);
    }
    const decompressions = outputs.map(({ library, output }) => ({
      library,
      input: ownOutput ? output : first.output,
    }));
    // A library that cannot decompress its input would be timed failing.
    for (const { library, input } of decompressions) {
      if (Buffer.compare(library.decompress(input), data) !== 0) {
        throw new Error(`${group}: ${library.name} does not restore the input`);
      }
    }
    recordSizes(
      group,
      data.length,
      Object.fromEntries(outputs.map(({ library, output }) => [library.name, output.length])),
    );

    test(`${format} compress ${setting} - ${label}`, async ({ bench }) => {
      await runBenchmarks(
        bench,
        libraries.map((library) =>
          bench(library.name, () => {
            library.compress(data);
          }),
        ),
      );
    });

    test(`${format} decompress ${setting} - ${label}`, async ({ bench }) => {
      await runBenchmarks(
        bench,
        decompressions.map(({ library, input }) =>
          bench(library.name, () => {
            library.decompress(input);
          }),
        ),
      );
    });
  }
}

/** Runs a benchmark alone, or compares several. */
export async function runBenchmarks(
  bench: Bench,
  benchmarks: readonly BenchRegistration<string>[],
): Promise<void> {
  const [first, ...others] = benchmarks;
  if (first === undefined) {
    throw new Error('no benchmark to run');
  }
  if (others.length === 0) {
    await first.run(BENCH_OPTIONS);
  } else {
    await bench.compare(first, ...others, BENCH_OPTIONS);
  }
}
