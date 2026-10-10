import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Transform } from 'node:stream';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isArrayBuffer } from 'node:util/types';
import { describe, expect, it, vi } from 'vitest';
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
  createDecompressTransform,
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
import { BOMB_FORMATS, type BombFormat, makeBomb, peakRssKiB } from './bomb-fixtures.js';

const ROOT = resolve(__dirname, '..');

/**
 * The exports of node:worker_threads that node.js calls, which a test
 * replaces. Its ES module namespace cannot be changed.
 */
const workerThreads: typeof import('node:worker_threads') =
  createRequire(__filename)('node:worker_threads');

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

describe('Node transform decompression of a single highly compressible chunk', () => {
  const limit = 64 * 1024;
  const bombMiB = 128;
  const createTransform: Record<BombFormat, (maxOutputSize: number) => Transform> = {
    gzip: createGzipDecompressTransform,
    deflate: createDeflateDecompressTransform,
    brotli: createBrotliDecompressTransform,
    zstd: createZstdDecompressTransform,
  };

  it('should stop inflating once maxOutputSize is reached', async () => {
    const bombs = await Promise.all(
      BOMB_FORMATS.map(async (format) => ({ format, bomb: await makeBomb(format, bombMiB) })),
    );
    const peakBefore = peakRssKiB();

    for (const { format, bomb } of bombs) {
      await expect(
        collectTransform(Readable.from([bomb]), createTransform[format](limit)),
      ).rejects.toThrow(`exceeded maximum size of ${limit} bytes`);
    }

    // Inflating any one of the chunks completely would add 128 MiB.
    expect(peakRssKiB() - peakBefore).toBeLessThan(32 * 1024);
  });
});

describe('Node transform output chunk size', () => {
  // 8 MiB of zeros compress to a few KiB, which one transform() call
  // decompresses at once.
  const plain = Buffer.alloc(8 * 1024 * 1024);
  const CASES: [string, () => Buffer, () => Transform][] = [
    ['zstd', () => zstdCompress(plain), () => createZstdDecompressTransform()],
    ['gzip', () => gzipCompress(plain), () => createGzipDecompressTransform()],
    ['deflate', () => deflateCompress(plain), () => createDeflateDecompressTransform()],
    ['brotli', () => brotliCompress(plain, 1), () => createBrotliDecompressTransform()],
    ['lz4', () => lz4Compress(plain), () => createLz4DecompressTransform()],
    ['auto-detected zstd', () => zstdCompress(plain), () => createDecompressTransform()],
    ['auto-detected brotli', () => brotliCompress(plain, 1), () => createDecompressTransform()],
  ];

  it.each(CASES)(
    'should push %s output in chunks of at most readableHighWaterMark bytes',
    { timeout: 30_000 },
    async (_name, compress, createTransform) => {
      const transform = createTransform();
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      });
      await pipeline(Readable.from([compress()]), transform, sink);

      expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(
        transform.readableHighWaterMark,
      );
      expect(Buffer.concat(chunks).equals(plain)).toBe(true);
    },
  );
});

describe('Node transform output chunk transfer', () => {
  // A stream context returns 1 MiB in memory that V8 owns, from transform()
  // for zstd and from flush() for LZ4, and the transform pushes it in chunks
  // of 64 KiB that share its ArrayBuffer. Transferring one of them would
  // detach the others before the stream emits them.
  const plain = Buffer.alloc(1024 * 1024, 'transferred chunks of comprs ');
  const CASES: [string, (data: Buffer) => Buffer, () => Transform][] = [
    ['transform() (zstd)', zstdCompress, () => createZstdDecompressTransform()],
    ['flush() (LZ4)', lz4Compress, () => createLz4DecompressTransform()],
  ];
  const DETACHED = 'an output chunk was transferred, which detached the other chunks';

  /**
   * A sink that transfers each chunk, as a reader that posts the chunks to a
   * worker does, after it adds the chunk to `seen` and before it adds the
   * transferred copy to `moved`. A transfer that throws fails the sink.
   */
  function transferringSink(seen: Buffer[], moved: Uint8Array[]): Writable {
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        seen.push(chunk);
        try {
          const { buffer } = chunk;
          if (!isArrayBuffer(buffer)) throw new Error('expected an ArrayBuffer');
          moved.push(structuredClone(chunk, { transfer: [buffer] }));
          callback();
        } catch (err) {
          callback(err as Error);
        }
      },
    });
  }

  it.each(CASES)(
    'should refuse to transfer one of several chunks of a result from %s',
    async (_name, compress, createTransform) => {
      const seen: Buffer[] = [];
      const moved: Uint8Array[] = [];
      await expect(
        pipeline(
          Readable.from([compress(plain)]),
          createTransform(),
          transferringSink(seen, moved),
        ),
      ).rejects.toThrow(expect.objectContaining({ name: 'DataCloneError' }));
      // The first chunk was a view of the whole result, and none was moved.
      expect(seen[0]?.buffer.byteLength).toBe(plain.byteLength);
      expect(moved).toEqual([]);
    },
  );

  // Where markAsUntransferable() has no effect, a transfer while the
  // transform pushes a chunk detaches the rest of the result. The stream
  // must then fail instead of ending without it.
  it.each(CASES)(
    'should fail instead of ending short if a runtime lets it transfer a chunk of a result from %s',
    async (_name, compress, createTransform) => {
      const mark = vi.spyOn(workerThreads, 'markAsUntransferable').mockImplementation(() => {});
      try {
        const seen: Buffer[] = [];
        const moved: Uint8Array[] = [];
        await expect(
          pipeline(
            Readable.from([compress(plain)]),
            createTransform(),
            transferringSink(seen, moved),
          ),
        ).rejects.toThrow(DETACHED);
        expect(mark).toHaveBeenCalledOnce();
        // The one transfer took the whole result along.
        expect(moved.map((chunk) => chunk.buffer.byteLength)).toEqual([plain.byteLength]);
      } finally {
        mark.mockRestore();
      }
    },
  );

  // Bun 1.3 and Deno before 2.7.6 export a markAsUntransferable() that
  // throws that it is not implemented. The script makes it throw before it
  // loads node.js, in a process of its own, as loading node.js a second
  // time here would spoil its coverage.
  it('should work where markAsUntransferable() is not implemented', {
    timeout: 60_000,
  }, () => {
    const script = resolve(__dirname, 'fixtures/unmarked-transfer.cjs');
    const stdout = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000 });
    const result: unknown = JSON.parse(stdout);
    expect(result).toEqual({
      kept: plain.byteLength,
      transferred: expect.stringContaining(DETACHED),
    });
  });

  it('should push a result that fits in one chunk as a chunk that can be transferred', async () => {
    const data = plain.subarray(0, 32 * 1024);
    const seen: Buffer[] = [];
    const moved: Uint8Array[] = [];
    await pipeline(
      Readable.from([zstdCompress(data)]),
      createZstdDecompressTransform(),
      transferringSink(seen, moved),
    );
    expect(seen.length).toBe(1);
    expect(seen.every((chunk) => chunk.byteLength === 0)).toBe(true);
    expect(Buffer.concat(moved).equals(data)).toBe(true);
  });
});

describe('Node transform errors from another realm', () => {
  // How long the Node.js process may run. Vitest fails a test that outlasts
  // its own timeout (5 s by default) even while it waits in execFileSync.
  const PROCESS_TIMEOUT = 30_000;

  // Jest runs the code of a package in a vm context, but loads native addons
  // and Node.js modules in the main realm, so the errors that the stream
  // contexts throw are not instances of the Error that node.js sees. The test
  // runs in a process of its own, as loading node.js a second time here would
  // spoil its coverage.
  it('should emit the error that the stream context threw', {
    timeout: 2 * PROCESS_TIMEOUT,
  }, () => {
    const script = [
      "const { readFileSync } = require('node:fs');",
      "const { createRequire } = require('node:module');",
      "const { join } = require('node:path');",
      "const vm = require('node:vm');",
      "const file = join(process.cwd(), 'node.js');",
      'function loadInContext() {',
      "  const source = '(function (exports, require, module) {' + readFileSync(file, 'utf8') + '\\n})';",
      '  const wrapper = vm.runInNewContext(source, { Buffer }, { filename: file });',
      '  const module = { exports: {} };',
      '  wrapper(module.exports, createRequire(file), module);',
      '  return module.exports;',
      '}',
      'function streamError(node) {',
      '  return new Promise((resolve) => {',
      '    const transform = node.createZstdDecompressTransform();',
      "    transform.on('error', (err) => resolve({ code: err.code, message: err.message }));",
      "    transform.end(Buffer.from('not zstd data'));",
      '  });',
      '}',
      'Promise.all([streamError(require(file)), streamError(loadInContext())]).then((errors) => {',
      '  process.stdout.write(JSON.stringify(errors));',
      '});',
    ].join('\n');
    const [native, inContext]: unknown[] = JSON.parse(
      execFileSync(process.execPath, ['--eval', script], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT,
      }),
    );

    expect(native).toEqual({ code: 'GenericFailure', message: expect.any(String) });
    expect(inContext).toEqual(native);
  });
});
