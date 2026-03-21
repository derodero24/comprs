import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { brotliCompress, gzipCompress, zstdCompress } from '../index.js';
import { createDecompressTransform } from '../node.js';
import { createDecompressStream } from '../streams.js';

/** Collect all chunks from a ReadableStream into a single Buffer. */
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

/** Create a ReadableStream from data, split into chunks of the given size. */
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

/** Create a Node.js Readable from data, split into chunks of the given size. */
function toChunkedReadable(data: Buffer, chunkSize: number): Readable {
  let offset = 0;
  return new Readable({
    read() {
      if (offset >= data.length) {
        this.push(null);
        return;
      }
      const end = Math.min(offset + chunkSize, data.length);
      this.push(data.subarray(offset, end));
      offset = end;
    },
  });
}

/** Collect output from source piped through a transform into a Buffer. */
async function collectTransform(
  source: Readable,
  transform: NodeJS.ReadWriteStream,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline(source, transform, sink);
  return Buffer.concat(chunks);
}

const original = Buffer.from('Hello, auto-detect streaming decompression! '.repeat(100));

describe('createDecompressStream', () => {
  it('should auto-detect and decompress zstd data', async () => {
    const compressed = zstdCompress(original);
    const stream = toChunkedStream(compressed, 64);
    const result = await collectStream(stream.pipeThrough(createDecompressStream()));
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-detect and decompress gzip data', async () => {
    const compressed = gzipCompress(original);
    const stream = toChunkedStream(compressed, 64);
    const result = await collectStream(stream.pipeThrough(createDecompressStream()));
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-detect and decompress brotli data', async () => {
    const compressed = brotliCompress(original);
    const stream = toChunkedStream(compressed, 64);
    const result = await collectStream(stream.pipeThrough(createDecompressStream()));
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should handle small first chunk (< 4 bytes) with buffering', async () => {
    const compressed = zstdCompress(original);
    const stream = toChunkedStream(compressed, 2);
    const result = await collectStream(stream.pipeThrough(createDecompressStream()));
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should throw on unknown format', async () => {
    const data = Buffer.from('this is not compressed data at all');
    const stream = toChunkedStream(data, 64);
    await expect(collectStream(stream.pipeThrough(createDecompressStream()))).rejects.toThrow(
      /unable to detect compression format/,
    );
  });

  it('should handle single chunk', async () => {
    const compressed = gzipCompress(original);
    const stream = toChunkedStream(compressed, compressed.length);
    const result = await collectStream(stream.pipeThrough(createDecompressStream()));
    expect(Buffer.compare(result, original)).toBe(0);
  });
});

describe('createDecompressTransform', () => {
  it('should auto-detect and decompress zstd data', async () => {
    const compressed = Buffer.from(zstdCompress(original));
    const source = toChunkedReadable(compressed, 64);
    const result = await collectTransform(source, createDecompressTransform());
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-detect and decompress gzip data', async () => {
    const compressed = Buffer.from(gzipCompress(original));
    const source = toChunkedReadable(compressed, 64);
    const result = await collectTransform(source, createDecompressTransform());
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-detect and decompress brotli data', async () => {
    const compressed = Buffer.from(brotliCompress(original));
    const source = toChunkedReadable(compressed, 64);
    const result = await collectTransform(source, createDecompressTransform());
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should handle small first chunk (< 4 bytes) with buffering', async () => {
    const compressed = Buffer.from(zstdCompress(original));
    const source = toChunkedReadable(compressed, 2);
    const result = await collectTransform(source, createDecompressTransform());
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should throw on unknown format', async () => {
    const data = Buffer.from('this is not compressed data at all');
    const source = toChunkedReadable(data, 64);
    await expect(collectTransform(source, createDecompressTransform())).rejects.toThrow(
      /unable to detect compression format/,
    );
  });

  it('should handle single chunk', async () => {
    const compressed = Buffer.from(gzipCompress(original));
    const source = toChunkedReadable(compressed, compressed.length);
    const result = await collectTransform(source, createDecompressTransform());
    expect(Buffer.compare(result, original)).toBe(0);
  });
});
