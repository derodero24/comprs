import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32 } from '../index.js';

const zlibCrc32Available = typeof zlib.crc32 === 'function';

describe('crc32', () => {
  it('should compute CRC32 of empty data', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('should compute CRC32 of known test vector', () => {
    // CRC32 of "123456789" = 0xCBF43926
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('should compute CRC32 of single byte', () => {
    const result = crc32(Buffer.from([0x00]));
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('should support incremental computation', () => {
    const data = Buffer.from('Hello, World!');
    const part1 = data.subarray(0, 5);
    const part2 = data.subarray(5);

    const full = crc32(data);
    const incremental = crc32(part2, crc32(part1));
    expect(incremental).toBe(full);
  });

  it('should accept Uint8Array input', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const result = crc32(data);
    expect(typeof result).toBe('number');
    expect(result).toBe(crc32(Buffer.from([1, 2, 3, 4, 5])));
  });

  it.skipIf(!zlibCrc32Available)('should match Node.js zlib.crc32', () => {
    const data = Buffer.from('test data for crc32 interop');
    expect(crc32(data)).toBe(zlib.crc32(data));
  });

  it('should handle large data', () => {
    const data = Buffer.alloc(1024 * 1024, 0xab);
    const result = crc32(data);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('should return consistent results', () => {
    const data = Buffer.from('consistency test');
    expect(crc32(data)).toBe(crc32(data));
  });

  it('should handle multi-part incremental correctly', () => {
    const chunks = [Buffer.from('chunk1'), Buffer.from('chunk2'), Buffer.from('chunk3')];
    const combined = Buffer.concat(chunks);

    const chunk0 = chunks[0] as Buffer;
    const chunk1 = chunks[1] as Buffer;
    const chunk2 = chunks[2] as Buffer;

    let checksum = crc32(chunk0);
    checksum = crc32(chunk1, checksum);
    checksum = crc32(chunk2, checksum);

    expect(checksum).toBe(crc32(combined));
  });
});
