import { describe, expect, it } from 'vitest';
import {
  decompress,
  decompressAsync,
  detectFormat,
  Lz4DecompressContext,
  lz4Compress,
  lz4CompressAsync,
  lz4Decompress,
  lz4DecompressAsync,
  lz4DecompressWithCapacity,
  lz4DecompressWithCapacityAsync,
} from '../index.js';
import {
  createDecompressStream,
  createLz4CompressStream,
  createLz4DecompressStream,
} from '../streams.js';

describe('lz4Compress / lz4Decompress', () => {
  it('should round-trip a simple string', () => {
    const input = Buffer.from('Hello, comprs LZ4!');
    const compressed = lz4Compress(input);
    const decompressed = lz4Decompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', () => {
    const input = Buffer.alloc(0);
    const compressed = lz4Compress(input);
    const decompressed = lz4Decompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip a 1-byte buffer', () => {
    const input = Buffer.from([42]);
    const compressed = lz4Compress(input);
    const decompressed = lz4Decompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip 1KB of data', () => {
    const input = Buffer.alloc(1024, 'a');
    const compressed = lz4Compress(input);
    const decompressed = lz4Decompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip 1MB of data', () => {
    const input = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < input.length; i++) {
      input[i] = i % 256;
    }
    const compressed = lz4Compress(input);
    const decompressed = lz4Decompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should actually compress repetitive data', () => {
    const input = Buffer.alloc(10000, 'x');
    const compressed = lz4Compress(input);
    expect(compressed.length).toBeLessThan(input.length);
  });

  it('should throw on invalid compressed data', () => {
    const invalid = Buffer.from('this is not lz4 data');
    expect(() => lz4Decompress(invalid)).toThrow();
  });

  it('should accept Uint8Array input', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const compressed = lz4Compress(input);
    const decompressed = lz4Decompress(compressed);
    expect(Buffer.from(decompressed)).toEqual(Buffer.from(input));
  });

  it('should produce LZ4 frame magic bytes', () => {
    const compressed = lz4Compress(Buffer.from('test'));
    expect(compressed[0]).toBe(0x04);
    expect(compressed[1]).toBe(0x22);
    expect(compressed[2]).toBe(0x4d);
    expect(compressed[3]).toBe(0x18);
  });
});

describe('lz4DecompressWithCapacity', () => {
  it('should decompress within capacity', () => {
    const input = Buffer.from('Hello, LZ4 capacity!');
    const compressed = lz4Compress(input);
    const decompressed = lz4DecompressWithCapacity(compressed, 1024);
    expect(decompressed).toEqual(input);
  });

  it('should throw when decompressed size exceeds capacity', () => {
    const input = Buffer.alloc(2048, 'a');
    const compressed = lz4Compress(input);
    expect(() => lz4DecompressWithCapacity(compressed, 1024)).toThrow(/exceeded maximum size/);
  });

  it('should throw on negative capacity', () => {
    expect(() => lz4DecompressWithCapacity(Buffer.from('test'), -1)).toThrow(/capacity/);
  });

  it('should throw on NaN capacity', () => {
    expect(() => lz4DecompressWithCapacity(Buffer.from('test'), Number.NaN)).toThrow(/capacity/);
  });
});

describe('lz4 async', () => {
  it('should round-trip with async compress/decompress', async () => {
    const input = Buffer.from('Async LZ4 test data '.repeat(50));
    const compressed = await lz4CompressAsync(input);
    const decompressed = await lz4DecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip with async decompress with capacity', async () => {
    const input = Buffer.from('Async capacity test');
    const compressed = lz4Compress(input);
    const decompressed = await lz4DecompressWithCapacityAsync(compressed, 1024);
    expect(decompressed).toEqual(input);
  });
});

describe('lz4 format detection', () => {
  it('should detect LZ4 format', () => {
    const compressed = lz4Compress(Buffer.from('detect me'));
    expect(detectFormat(compressed)).toBe('lz4');
  });

  it('should auto-decompress LZ4 data', () => {
    const input = Buffer.from('auto decompress LZ4');
    const compressed = lz4Compress(input);
    const decompressed = decompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should async auto-decompress LZ4 data', async () => {
    const input = Buffer.from('async auto decompress LZ4');
    const compressed = lz4Compress(input);
    const decompressed = await decompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });
});

function toChunkedStream(data: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < data.length; i += chunkSize) {
        controller.enqueue(data.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe('lz4 streaming', () => {
  it('should round-trip through compress/decompress streams', async () => {
    const input = Buffer.from('Streaming LZ4 test data! '.repeat(100));
    const compressed = await collectStream(
      toChunkedStream(input, 256).pipeThrough(createLz4CompressStream()),
    );
    const decompressed = lz4Decompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should decompress through stream', async () => {
    const input = Buffer.from('LZ4 decompress stream test '.repeat(50));
    const compressed = lz4Compress(input);
    const decompressed = await collectStream(
      toChunkedStream(compressed, 64).pipeThrough(createLz4DecompressStream()),
    );
    expect(decompressed).toEqual(input);
  });

  it('should write a content checksum', async () => {
    const compressed = await collectStream(
      toChunkedStream(Buffer.from('LZ4 stream checksum '.repeat(50)), 256).pipeThrough(
        createLz4CompressStream(),
      ),
    );
    expect(compressed[4]).toBe(0x64);
  });

  it('should auto-detect LZ4 in decompress stream', async () => {
    const input = Buffer.from('Auto-detect LZ4 stream test');
    const compressed = lz4Compress(input);
    const decompressed = await collectStream(
      toChunkedStream(compressed, compressed.length).pipeThrough(createDecompressStream()),
    );
    expect(decompressed).toEqual(input);
  });
});

describe('lz4 frames', () => {
  const hello = lz4Compress(Buffer.from('Hello '));
  const world = lz4Compress(Buffer.from('World'));
  const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);
  const truncated = 'lz4 stream is truncated: unexpected end of input';

  it('should write a content checksum', () => {
    // FLG: version 01, independent blocks, content checksum.
    expect(hello[4]).toBe(0x64);
  });

  it('should detect corrupted block data', () => {
    const corrupted = Buffer.from(lz4Compress(Buffer.from('The quick brown fox. '.repeat(20))));
    // The last 5 bytes of a block are literals; the end mark and the content
    // checksum follow them.
    const lastLiteral = corrupted.length - 9;
    corrupted.writeUInt8(corrupted.readUInt8(lastLiteral) ^ 0x01, lastLiteral);
    expect(() => lz4Decompress(corrupted)).toThrow(/ContentChecksumError/);
  });

  it('should decode concatenated frames', async () => {
    const input = Buffer.concat([hello, world]);
    expect(lz4Decompress(input).toString()).toBe('Hello World');
    expect((await lz4DecompressAsync(input)).toString()).toBe('Hello World');
    expect(decompress(input).toString()).toBe('Hello World');
    expect(lz4DecompressWithCapacity(input, 11).toString()).toBe('Hello World');
    expect(() => lz4DecompressWithCapacity(input, 10)).toThrow(
      'lz4 decompress exceeded maximum size of 10 bytes',
    );
    const streamed = await collectStream(
      toChunkedStream(input, 5).pipeThrough(createLz4DecompressStream()),
    );
    expect(streamed.toString()).toBe('Hello World');
  });

  it('should skip skippable frames', () => {
    const input = Buffer.concat([skippable, hello, skippable, world, skippable]);
    expect(lz4Decompress(input).toString()).toBe('Hello World');
    expect(lz4Decompress(skippable)).toEqual(Buffer.alloc(0));
  });

  it('should reject a frame cut short', () => {
    // Every prefix, including the one that stops right before the end mark.
    for (let length = 1; length < hello.length; length++) {
      expect(() => lz4Decompress(hello.subarray(0, length))).toThrow(truncated);
    }
    expect(() => lz4Decompress(Buffer.concat([hello, world.subarray(0, 10)]))).toThrow(truncated);
  });

  it('should reject data after the last frame', async () => {
    const input = Buffer.concat([hello, Buffer.from('garbage')]);
    expect(() => lz4Decompress(input)).toThrow(
      'lz4 decompress failed: unexpected data after the end of a frame',
    );
    const ctx = new Lz4DecompressContext();
    ctx.transform(input);
    expect(() => ctx.flush()).toThrow(
      'lz4 stream decompress failed: unexpected data after the end of a frame',
    );
    await expect(
      collectStream(toChunkedStream(input, 4).pipeThrough(createLz4DecompressStream())),
    ).rejects.toThrow('lz4 stream decompress failed: unexpected data after the end of a frame');
  });
});
