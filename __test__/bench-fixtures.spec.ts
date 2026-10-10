import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc32, zstdCompress } from '../index.js';
import {
  deterministicBytes,
  INPUTS,
  JSON_DATA,
  RANDOM_LARGE,
  RANDOM_MEDIUM,
  recordSizes,
} from './bench-fixtures.js';

// crates/bench/src/lib.rs checks the same values, so the Rust and JS
// benchmarks compress the same bytes.
describe('bench fixtures', () => {
  it('generate the same pseudo-random bytes as the Rust benchmarks', () => {
    expect(deterministicBytes(16, 0x1234).toString('hex')).toBe('0af58f2a1df4f9e91e4a28f6c95a0284');
    expect(crc32(RANDOM_MEDIUM)).toBe(0x5d1aaf7f);
    expect(crc32(RANDOM_LARGE)).toBe(0xe9327575);
  });

  it('generate the same JSON as the Rust benchmarks', () => {
    expect(JSON_DATA.length).toBe(86_216);
    expect(crc32(JSON_DATA)).toBe(0xb2e2ca75);
  });

  // zstd's window covers the whole input, so a repeat at any distance would
  // make the data compress.
  it.each([
    ['10KB', RANDOM_MEDIUM],
    ['1MB', RANDOM_LARGE],
  ])('random %s data does not compress', (_, data) => {
    expect(zstdCompress(data).length).toBeGreaterThanOrEqual(data.length * 0.99);
  });
});

describe('comparison inputs', () => {
  // The README tables name the inputs by these labels.
  it.each(INPUTS)('$label has the size that its label names', ({ label, data }) => {
    const size = /(\d+)(B|KB|MB)$/.exec(label);
    expect(size).not.toBeNull();
    const [, count = '', unit = ''] = size ?? [];
    const scale = { B: 1, KB: 1024, MB: 1024 ** 2 }[unit] ?? Number.NaN;
    expect(Math.round(data.length / scale)).toBe(Number(count));
  });
});

describe('recordSizes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('merges the sizes of each group into the file that COMPRS_BENCH_SIZES names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'comprs-bench-sizes-'));
    try {
      const file = join(dir, 'sizes.json');
      vi.stubEnv('COMPRS_BENCH_SIZES', file);
      recordSizes('gzip level 6 - JSON 84KB', 100, { comprs: 10, pako: 12 });
      recordSizes('zstd level 3 - JSON 84KB', 100, { comprs: 9 });
      recordSizes('gzip level 6 - JSON 84KB', 100, { comprs: 11, pako: 12 });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        'gzip level 6 - JSON 84KB': { inputLength: 100, sizes: { comprs: 11, pako: 12 } },
        'zstd level 3 - JSON 84KB': { inputLength: 100, sizes: { comprs: 9 } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
