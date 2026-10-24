import { randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { deflateCompress } from '@derodero24/comprs';
import { describe, expect, it } from 'vitest';

import { ADLER32_INITIAL, adler32, toZlib, zlibHeader, zlibTrailer } from '../src/zlib.js';

/** The Adler-32 checksum that Node's zlib writes at the end of its output. */
function zlibAdler32(data: Uint8Array): number {
  const output = deflateSync(data);
  return output.readUInt32BE(output.length - 4);
}

describe('adler32', () => {
  it('should match the reference value', () => {
    expect(adler32(Buffer.from('Wikipedia'), ADLER32_INITIAL)).toBe(0x11e60398);
    expect(adler32(new Uint8Array(0), ADLER32_INITIAL)).toBe(1);
  });

  it('should match zlib across reduction blocks, including the largest byte values', () => {
    for (const data of [Buffer.alloc(100_000, 0xff), randomBytes(50_000)]) {
      expect(adler32(data, ADLER32_INITIAL)).toBe(zlibAdler32(data));
    }
  });

  it('should give the checksum of the whole when fed in pieces', () => {
    const data = randomBytes(20_000);
    let checksum = ADLER32_INITIAL;
    for (let start = 0; start < data.length; start += 777) {
      checksum = adler32(data.subarray(start, start + 777), checksum);
    }
    expect(checksum).toBe(zlibAdler32(data));
  });
});

describe('zlibHeader', () => {
  it.each([0, 1, 2, 5, 6, 7, 9])('should match the header zlib writes at level %i', (level) => {
    const header = zlibHeader(level);
    expect(Buffer.from(header)).toEqual(deflateSync('', { level }).subarray(0, 2));
    expect(((header[0] ?? 0) * 256 + (header[1] ?? 0)) % 31).toBe(0);
  });

  it('should use the default level when none is given', () => {
    expect([...zlibHeader()]).toEqual([0x78, 0x9c]);
  });
});

describe('zlibTrailer', () => {
  it('should write the checksum big-endian', () => {
    expect([...zlibTrailer(0x11e60398)]).toEqual([0x11, 0xe6, 0x03, 0x98]);
  });
});

describe('toZlib', () => {
  it.each([
    { label: 'text', data: Buffer.from('Hello, World! '.repeat(200)) },
    { label: 'random bytes', data: randomBytes(10_000) },
    { label: 'no data', data: Buffer.alloc(0) },
  ])('should produce zlib data that zlib inflates ($label)', ({ data }) => {
    for (const level of [0, 6, 9]) {
      const wrapped = toZlib(deflateCompress(data, level), data, level);
      expect(inflateSync(wrapped)).toEqual(data);
    }
  });
});
