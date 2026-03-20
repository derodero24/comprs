import { describe, expect, it } from 'vitest';
import {
  zstdCompress,
  zstdCompressWithDict,
  zstdDecompressWithDict,
  zstdTrainDictionary,
} from '../index.js';

describe('zstd dictionary compression', () => {
  // Generate sample data (JSON-like patterns)
  const samples = Array.from({ length: 100 }, (_, i) =>
    Buffer.from(
      JSON.stringify({
        id: i,
        name: `user_${i}`,
        email: `user${i}@example.com`,
        active: i % 2 === 0,
      }),
    ),
  );

  it('should train a dictionary from samples', () => {
    const dict = zstdTrainDictionary(samples);
    expect(dict.length).toBeGreaterThan(0);
  });

  it('should round-trip with dictionary', () => {
    const dict = zstdTrainDictionary(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 999,
        name: 'test_user',
        email: 'test@example.com',
        active: true,
      }),
    );
    const compressed = zstdCompressWithDict(original, dict);
    const decompressed = zstdDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should compress better than without dictionary for small data', () => {
    const dict = zstdTrainDictionary(samples);
    const small = Buffer.from(
      JSON.stringify({
        id: 42,
        name: 'dict_test',
        email: 'dict@test.com',
        active: true,
      }),
    );
    const withDict = zstdCompressWithDict(small, dict);
    const withoutDict = zstdCompress(small);
    expect(withDict.length).toBeLessThan(withoutDict.length);
  });
});
