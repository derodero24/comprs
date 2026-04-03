import { randomBytes } from 'node:crypto';
import type { Transform } from 'node:stream';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import {
  brotliCompress,
  brotliCompressWithDict,
  brotliDecompress,
  brotliDecompressWithDict,
  deflateCompress,
  deflateDecompress,
  gzipCompress,
  gzipDecompress,
  lz4Compress,
  lz4Decompress,
  zstdCompress,
  zstdCompressWithDict,
  zstdDecompress,
  zstdDecompressWithDict,
  zstdTrainDictionary,
} from '../index.js';
import {
  createBrotliCompressDictTransform,
  createBrotliCompressTransform,
  createBrotliDecompressDictTransform,
  createBrotliDecompressTransform,
  createDeflateCompressTransform,
  createDeflateDecompressTransform,
  createGzipCompressTransform,
  createGzipDecompressTransform,
  createLz4CompressTransform,
  createLz4DecompressTransform,
  createZstdCompressDictTransform,
  createZstdCompressTransform,
  createZstdDecompressDictTransform,
  createZstdDecompressTransform,
} from '../node.js';

/** Collect output from source piped through a single transform into a Buffer. */
async function collectTransform(source: Readable, transform: Transform): Promise<Buffer> {
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

/** Collect output from source piped through two transforms into a Buffer. */
async function collectTransform2(source: Readable, t1: Transform, t2: Transform): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline(source, t1, t2, sink);
  return Buffer.concat(chunks);
}

/** Create a Readable from data, split into chunks of the given size. */
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

describe('createZstdCompressTransform', () => {
  const data = Buffer.from('Hello, comprs node stream! '.repeat(100));

  it('should compress data through pipeline', async () => {
    const source = toChunkedReadable(data, 256);
    const compressed = await collectTransform(source, createZstdCompressTransform());
    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should accept compression level', async () => {
    const source = toChunkedReadable(data, 256);
    const compressed = await collectTransform(source, createZstdCompressTransform(19));
    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle small chunks', async () => {
    const source = toChunkedReadable(data, 16);
    const compressed = await collectTransform(source, createZstdCompressTransform());
    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle empty input', async () => {
    const source = toChunkedReadable(Buffer.alloc(0), 1);
    const compressed = await collectTransform(source, createZstdCompressTransform());
    const decompressed = zstdDecompress(compressed);
    expect(decompressed.length).toBe(0);
  });

  it('should handle random (incompressible) data', async () => {
    const random = randomBytes(10_000);
    const source = toChunkedReadable(random, 512);
    const compressed = await collectTransform(source, createZstdCompressTransform());
    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, random)).toBe(0);
  });
});

describe('createZstdDecompressTransform', () => {
  const data = Buffer.from('Hello, comprs node stream decompression! '.repeat(100));
  const compressed = Buffer.from(zstdCompress(data));

  it('should decompress data through pipeline', async () => {
    const source = toChunkedReadable(compressed, 64);
    const decompressed = await collectTransform(source, createZstdDecompressTransform());
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle single chunk', async () => {
    const source = toChunkedReadable(compressed, compressed.length);
    const decompressed = await collectTransform(source, createZstdDecompressTransform());
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('zstd node stream round-trip', () => {
  it('should compress then decompress through pipeline', async () => {
    const data = Buffer.from('Piped zstd node stream test '.repeat(200));
    const source = toChunkedReadable(data, 128);
    const result = await collectTransform2(
      source,
      createZstdCompressTransform(),
      createZstdDecompressTransform(),
    );
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should handle large data (1MB)', { timeout: 30_000 }, async () => {
    const large = Buffer.alloc(1_000_000);
    for (let i = 0; i < large.length; i++) large[i] = i % 256;
    const source = toChunkedReadable(large, 64 * 1024);
    const result = await collectTransform2(
      source,
      createZstdCompressTransform(),
      createZstdDecompressTransform(),
    );
    expect(Buffer.compare(result, large)).toBe(0);
  });

  it('should interop with one-shot compress', async () => {
    const data = Buffer.from('Interop test data '.repeat(50));
    const oneShotCompressed = Buffer.from(zstdCompress(data));
    const source = toChunkedReadable(oneShotCompressed, 32);
    const result = await collectTransform(source, createZstdDecompressTransform());
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot decompress', async () => {
    const data = Buffer.from('Interop test data '.repeat(50));
    const source = toChunkedReadable(data, 64);
    const compressed = await collectTransform(source, createZstdCompressTransform());
    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('createGzipCompressTransform', () => {
  const data = Buffer.from('Hello, comprs gzip node stream! '.repeat(100));

  it('should compress data through pipeline', async () => {
    const source = toChunkedReadable(data, 256);
    const compressed = await collectTransform(source, createGzipCompressTransform());
    const decompressed = gzipDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should accept compression level', async () => {
    const source = toChunkedReadable(data, 256);
    const compressed = await collectTransform(source, createGzipCompressTransform(9));
    const decompressed = gzipDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle empty input', async () => {
    const source = toChunkedReadable(Buffer.alloc(0), 1);
    const compressed = await collectTransform(source, createGzipCompressTransform());
    const decompressed = gzipDecompress(compressed);
    expect(decompressed.length).toBe(0);
  });
});

describe('createGzipDecompressTransform', () => {
  const data = Buffer.from('Hello, comprs gzip node stream decompression! '.repeat(100));
  const compressed = Buffer.from(gzipCompress(data));

  it('should decompress data through pipeline', async () => {
    const source = toChunkedReadable(compressed, 64);
    const decompressed = await collectTransform(source, createGzipDecompressTransform());
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle single chunk', async () => {
    const source = toChunkedReadable(compressed, compressed.length);
    const decompressed = await collectTransform(source, createGzipDecompressTransform());
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('gzip node stream round-trip', () => {
  it('should compress then decompress through pipeline', async () => {
    const data = Buffer.from('Piped gzip node stream test '.repeat(200));
    const source = toChunkedReadable(data, 128);
    const result = await collectTransform2(
      source,
      createGzipCompressTransform(),
      createGzipDecompressTransform(),
    );
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot compress', async () => {
    const data = Buffer.from('Gzip interop test data '.repeat(50));
    const oneShotCompressed = Buffer.from(gzipCompress(data));
    const source = toChunkedReadable(oneShotCompressed, 32);
    const result = await collectTransform(source, createGzipDecompressTransform());
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot decompress', async () => {
    const data = Buffer.from('Gzip interop test data '.repeat(50));
    const source = toChunkedReadable(data, 64);
    const compressed = await collectTransform(source, createGzipCompressTransform());
    const decompressed = gzipDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('createDeflateCompressTransform', () => {
  const data = Buffer.from('Hello, comprs deflate node stream! '.repeat(100));

  it('should compress data through pipeline', async () => {
    const source = toChunkedReadable(data, 256);
    const compressed = await collectTransform(source, createDeflateCompressTransform());
    const decompressed = deflateDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should accept compression level', async () => {
    const source = toChunkedReadable(data, 256);
    const compressed = await collectTransform(source, createDeflateCompressTransform(9));
    const decompressed = deflateDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle empty input', async () => {
    const source = toChunkedReadable(Buffer.alloc(0), 1);
    const compressed = await collectTransform(source, createDeflateCompressTransform());
    const decompressed = deflateDecompress(compressed);
    expect(decompressed.length).toBe(0);
  });
});

describe('createDeflateDecompressTransform', () => {
  const data = Buffer.from('Hello, comprs deflate node stream decompression! '.repeat(100));
  const compressed = Buffer.from(deflateCompress(data));

  it('should decompress data through pipeline', async () => {
    const source = toChunkedReadable(compressed, 64);
    const decompressed = await collectTransform(source, createDeflateDecompressTransform());
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle single chunk', async () => {
    const source = toChunkedReadable(compressed, compressed.length);
    const decompressed = await collectTransform(source, createDeflateDecompressTransform());
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('deflate node stream round-trip', () => {
  it('should compress then decompress through pipeline', async () => {
    const data = Buffer.from('Piped deflate node stream test '.repeat(200));
    const source = toChunkedReadable(data, 128);
    const result = await collectTransform2(
      source,
      createDeflateCompressTransform(),
      createDeflateDecompressTransform(),
    );
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot compress', async () => {
    const data = Buffer.from('Deflate interop test data '.repeat(50));
    const oneShotCompressed = Buffer.from(deflateCompress(data));
    const source = toChunkedReadable(oneShotCompressed, 32);
    const result = await collectTransform(source, createDeflateDecompressTransform());
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot decompress', async () => {
    const data = Buffer.from('Deflate interop test data '.repeat(50));
    const source = toChunkedReadable(data, 64);
    const compressed = await collectTransform(source, createDeflateCompressTransform());
    const decompressed = deflateDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('createBrotliCompressTransform', () => {
  const data = Buffer.from('Hello, comprs brotli node stream! '.repeat(100));

  it('should compress data through pipeline', async () => {
    const source = toChunkedReadable(data, 256);
    const compressed = await collectTransform(source, createBrotliCompressTransform());
    const decompressed = brotliDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should accept compression quality', async () => {
    const source = toChunkedReadable(data, 256);
    const compressed = await collectTransform(source, createBrotliCompressTransform(11));
    const decompressed = brotliDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle empty input', async () => {
    const source = toChunkedReadable(Buffer.alloc(0), 1);
    const compressed = await collectTransform(source, createBrotliCompressTransform());
    const decompressed = brotliDecompress(compressed);
    expect(decompressed.length).toBe(0);
  });
});

describe('createBrotliDecompressTransform', () => {
  const data = Buffer.from('Hello, comprs brotli node stream decompression! '.repeat(100));
  const compressed = Buffer.from(brotliCompress(data));

  it('should decompress data through pipeline', async () => {
    const source = toChunkedReadable(compressed, 64);
    const decompressed = await collectTransform(source, createBrotliDecompressTransform());
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle single chunk', async () => {
    const source = toChunkedReadable(compressed, compressed.length);
    const decompressed = await collectTransform(source, createBrotliDecompressTransform());
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('brotli node stream round-trip', () => {
  it('should compress then decompress through pipeline', async () => {
    const data = Buffer.from('Piped brotli node stream test '.repeat(200));
    const source = toChunkedReadable(data, 128);
    const result = await collectTransform2(
      source,
      createBrotliCompressTransform(),
      createBrotliDecompressTransform(),
    );
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot compress', async () => {
    const data = Buffer.from('Brotli interop test data '.repeat(50));
    const oneShotCompressed = Buffer.from(brotliCompress(data));
    const source = toChunkedReadable(oneShotCompressed, 32);
    const result = await collectTransform(source, createBrotliDecompressTransform());
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot decompress', async () => {
    const data = Buffer.from('Brotli interop test data '.repeat(50));
    const source = toChunkedReadable(data, 64);
    const compressed = await collectTransform(source, createBrotliCompressTransform());
    const decompressed = brotliDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('lz4 node stream round-trip', () => {
  it('should compress then decompress through pipeline', async () => {
    const data = Buffer.from('Piped lz4 node stream test '.repeat(200));
    const source = toChunkedReadable(data, 128);
    const result = await collectTransform2(
      source,
      createLz4CompressTransform(),
      createLz4DecompressTransform(),
    );
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should handle small chunks', async () => {
    const data = Buffer.from('LZ4 small chunk test '.repeat(100));
    const source = toChunkedReadable(data, 16);
    const result = await collectTransform2(
      source,
      createLz4CompressTransform(),
      createLz4DecompressTransform(),
    );
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot compress', async () => {
    const data = Buffer.from('LZ4 interop test data '.repeat(50));
    const oneShotCompressed = Buffer.from(lz4Compress(data));
    const source = toChunkedReadable(oneShotCompressed, 32);
    const result = await collectTransform(source, createLz4DecompressTransform());
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot decompress', async () => {
    const data = Buffer.from('LZ4 interop test data '.repeat(50));
    const source = toChunkedReadable(data, 64);
    const compressed = await collectTransform(source, createLz4CompressTransform());
    const decompressed = lz4Decompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('zstd dict node stream round-trip', () => {
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

  it('should compress then decompress through pipeline with dict', async () => {
    const dict = zstdTrainDictionary(samples);
    const data = Buffer.from(
      JSON.stringify({
        id: 500,
        name: 'dict_stream_user',
        email: 'dict_stream@example.com',
        active: true,
      }),
    );
    const source = toChunkedReadable(data, 32);
    const result = await collectTransform2(
      source,
      createZstdCompressDictTransform(dict),
      createZstdDecompressDictTransform(dict),
    );
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot dict compress', async () => {
    const dict = zstdTrainDictionary(samples);
    const data = Buffer.from(
      JSON.stringify({
        id: 123,
        name: 'interop_dict_user',
        email: 'interop_dict@example.com',
        active: false,
      }),
    );
    const oneShotCompressed = Buffer.from(zstdCompressWithDict(data, dict));
    const source = toChunkedReadable(oneShotCompressed, 16);
    const result = await collectTransform(source, createZstdDecompressDictTransform(dict));
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot dict decompress', async () => {
    const dict = zstdTrainDictionary(samples);
    const data = Buffer.from(
      JSON.stringify({
        id: 456,
        name: 'interop_dict_user_2',
        email: 'interop_dict2@example.com',
        active: true,
      }),
    );
    const source = toChunkedReadable(data, 32);
    const compressed = await collectTransform(source, createZstdCompressDictTransform(dict));
    const decompressed = zstdDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('brotli dict node stream round-trip', () => {
  const dict = Buffer.from(
    Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        id: i,
        name: `user_${i}`,
        email: `user${i}@example.com`,
        active: i % 2 === 0,
      }),
    ).join(''),
  );

  it('should compress then decompress through pipeline with dict', async () => {
    const data = Buffer.from(
      JSON.stringify({
        id: 500,
        name: 'dict_stream_user',
        email: 'dict_stream@example.com',
        active: true,
      }),
    );
    const source = toChunkedReadable(data, 32);
    const result = await collectTransform2(
      source,
      createBrotliCompressDictTransform(dict),
      createBrotliDecompressDictTransform(dict),
    );
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot dict compress', async () => {
    const data = Buffer.from(
      JSON.stringify({
        id: 123,
        name: 'interop_dict_user',
        email: 'interop_dict@example.com',
        active: false,
      }),
    );
    const oneShotCompressed = Buffer.from(brotliCompressWithDict(data, dict));
    const source = toChunkedReadable(oneShotCompressed, 16);
    const result = await collectTransform(source, createBrotliDecompressDictTransform(dict));
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot dict decompress', async () => {
    const data = Buffer.from(
      JSON.stringify({
        id: 456,
        name: 'interop_dict_user_2',
        email: 'interop_dict2@example.com',
        active: true,
      }),
    );
    const source = toChunkedReadable(data, 32);
    const compressed = await collectTransform(source, createBrotliCompressDictTransform(dict));
    const decompressed = brotliDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});
