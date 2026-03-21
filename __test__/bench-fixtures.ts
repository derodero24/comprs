import { Buffer } from 'node:buffer';

// --- Deterministic pseudo-random data generator ---
// Uses a linear congruential generator for reproducible benchmark inputs,
// avoiding CodSpeed instruction count variance from non-deterministic randomBytes.
const deterministicBytes = (size: number, seed: number): Buffer => {
  const out = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (1664525 * x + 1013904223) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
};

// --- Patterned data (compressible) ---
export const SMALL = Buffer.from('Hello, zflate! '.repeat(10));
export const MEDIUM = Buffer.alloc(10_000);
for (let i = 0; i < MEDIUM.length; i++) MEDIUM[i] = i % 256;
export const LARGE = Buffer.alloc(1_000_000);
for (let i = 0; i < LARGE.length; i++) LARGE[i] = i % 256;

// --- Deterministic pseudo-random data (incompressible) ---
export const RANDOM_SMALL = deterministicBytes(150, 0x1234);
export const RANDOM_MEDIUM = deterministicBytes(10_000, 0x5678);
export const RANDOM_LARGE = deterministicBytes(1_000_000, 0x9abc);

// --- Realistic data ---
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
