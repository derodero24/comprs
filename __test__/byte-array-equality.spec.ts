import { describe, expect, it } from 'vitest';

// Tests of the equality tester that byte-array-equality.ts registers for
// every test file, through setupFiles in vitest.config.mts.

/** A Uint8Array that fails the test when something iterates over it. */
class UniterableBytes extends Uint8Array {
  override [Symbol.iterator](): never {
    throw new Error('iterated over the bytes');
  }
}

/** `length` bytes that count from 0 to 255 over and over, like the 1 MiB round-trip input. */
function countingBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = i % 256;
  }
  return bytes;
}

describe('toEqual and toStrictEqual on byte arrays', () => {
  it('should compare the bytes without iterating over them', () => {
    const a = new UniterableBytes(countingBytes(1024 * 1024));
    const b = new UniterableBytes(countingBytes(1024 * 1024));
    expect(a).toEqual(b);
    expect(a).toStrictEqual(b);
    expect({ chunks: [a] }).toEqual({ chunks: [b] });
  });

  it('should still fail for a one-byte difference', () => {
    const expected = countingBytes(1024);
    const actual = Buffer.from(expected);
    actual[700] = 0;
    expect(actual).not.toEqual(expected);
    expect(actual).not.toStrictEqual(expected);
    expect(new Uint8Array(actual)).not.toEqual(new Uint8Array(expected));
  });

  it('should still fail for a length difference', () => {
    const expected = countingBytes(1024);
    expect(expected.subarray(0, -1)).not.toEqual(expected);
    expect(expected).not.toEqual(expected.subarray(0, -1));
    expect(Buffer.concat([expected, Buffer.alloc(1)])).not.toStrictEqual(expected);
  });

  it('should still tell a Buffer from a Uint8Array', () => {
    const buffer = countingBytes(1024);
    expect(new Uint8Array(buffer)).not.toStrictEqual(buffer);
    expect(buffer).not.toStrictEqual(new Uint8Array(buffer));
  });
});
