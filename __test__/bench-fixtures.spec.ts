import { describe, expect, it } from 'vitest';
import { crc32 } from '../index.js';
import { JSON_DATA } from './bench-fixtures.js';

// crates/bench/src/lib.rs checks the same values, so the Rust and JS
// benchmarks compress the same bytes.
describe('bench fixtures', () => {
  it('generate the same JSON as the Rust benchmarks', () => {
    expect(JSON_DATA.length).toBe(86_216);
    expect(crc32(JSON_DATA)).toBe(0xb2e2ca75);
  });
});
