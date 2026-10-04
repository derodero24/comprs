import { describe, expect, it } from 'vitest';
import { crc32, zstdCompress } from '../index.js';
import { deterministicBytes, JSON_DATA, RANDOM_LARGE, RANDOM_MEDIUM } from './bench-fixtures.js';

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
