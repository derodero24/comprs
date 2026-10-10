import { randomBytes } from 'node:crypto';
import { isArrayBuffer } from 'node:util/types';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  BrotliCompressContext,
  brotliCompress,
  brotliCompressWithDict,
  brotliDecompress,
  brotliDecompressWithDict,
  DeflateCompressContext,
  deflateCompress,
  deflateDecompress,
  GzipCompressContext,
  gzipCompress,
  gzipDecompress,
  Lz4CompressContext,
  lz4Compress,
  lz4Decompress,
  ZstdCompressContext,
  zstdCompress,
  zstdCompressWithDict,
  zstdDecompress,
  zstdDecompressWithDict,
  zstdTrainDictionary,
} from '../index.js';
import {
  createBrotliCompressDictStream,
  createBrotliCompressStream,
  createBrotliDecompressDictStream,
  createBrotliDecompressStream,
  createDecompressStream,
  createDeflateCompressStream,
  createDeflateDecompressStream,
  createGzipCompressStream,
  createGzipDecompressStream,
  createLz4CompressStream,
  createLz4DecompressStream,
  createZstdCompressDictStream,
  createZstdCompressStream,
  createZstdDecompressDictStream,
  createZstdDecompressStream,
} from '../streams.js';
import { CHUNK_KINDS, type Chunk, readChunks, streamOf, toChunks } from './chunk-fixtures.js';

/** Collect all chunks from a ReadableStream into a single Buffer. */
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  // eslint-disable-next-line no-constant-condition
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

describe('createZstdCompressStream', () => {
  const data = Buffer.from('Hello, comprs streaming! '.repeat(100));

  it('should compress data through a stream', async () => {
    const stream = toChunkedStream(data, 256);
    const compressed = await collectStream(stream.pipeThrough(createZstdCompressStream()));
    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should accept compression level', async () => {
    const stream = toChunkedStream(data, 256);
    const compressed = await collectStream(stream.pipeThrough(createZstdCompressStream(19)));
    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle single chunk', async () => {
    const stream = toChunkedStream(data, data.length);
    const compressed = await collectStream(stream.pipeThrough(createZstdCompressStream()));
    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle small chunks', async () => {
    const stream = toChunkedStream(data, 16);
    const compressed = await collectStream(stream.pipeThrough(createZstdCompressStream()));
    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle empty input', async () => {
    const stream = toChunkedStream(Buffer.alloc(0), 1);
    const compressed = await collectStream(stream.pipeThrough(createZstdCompressStream()));
    const decompressed = zstdDecompress(compressed);
    expect(decompressed.length).toBe(0);
  });

  it('should handle random (incompressible) data', async () => {
    const random = randomBytes(10_000);
    const stream = toChunkedStream(random, 512);
    const compressed = await collectStream(stream.pipeThrough(createZstdCompressStream()));
    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, random)).toBe(0);
  });
});

describe('createZstdDecompressStream', () => {
  const data = Buffer.from('Hello, comprs streaming decompression! '.repeat(100));
  const compressed = zstdCompress(data);

  it('should decompress data through a stream', async () => {
    const stream = toChunkedStream(compressed, 64);
    const decompressed = await collectStream(stream.pipeThrough(createZstdDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle single chunk', async () => {
    const stream = toChunkedStream(compressed, compressed.length);
    const decompressed = await collectStream(stream.pipeThrough(createZstdDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle small chunks', async () => {
    const stream = toChunkedStream(compressed, 8);
    const decompressed = await collectStream(stream.pipeThrough(createZstdDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('streaming round-trip', () => {
  it('should compress then decompress through piped streams', async () => {
    const data = Buffer.from('Piped streaming test '.repeat(200));
    const stream = toChunkedStream(data, 128);

    const result = await collectStream(
      stream.pipeThrough(createZstdCompressStream()).pipeThrough(createZstdDecompressStream()),
    );
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should handle large data (1MB)', { timeout: 30_000 }, async () => {
    const large = Buffer.alloc(1_000_000);
    for (let i = 0; i < large.length; i++) large[i] = i % 256;
    const stream = toChunkedStream(large, 64 * 1024);

    const result = await collectStream(
      stream.pipeThrough(createZstdCompressStream()).pipeThrough(createZstdDecompressStream()),
    );
    expect(Buffer.compare(result, large)).toBe(0);
  });

  it('should interop with one-shot compress', async () => {
    const data = Buffer.from('Interop test data '.repeat(50));
    const oneShotCompressed = zstdCompress(data);

    const stream = toChunkedStream(oneShotCompressed, 32);
    const result = await collectStream(stream.pipeThrough(createZstdDecompressStream()));
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot decompress', async () => {
    const data = Buffer.from('Interop test data '.repeat(50));
    const stream = toChunkedStream(data, 64);
    const compressed = await collectStream(stream.pipeThrough(createZstdCompressStream()));

    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('chunk types', () => {
  // An even length, so that Uint16Array chunks cover all of it.
  const data = Buffer.from(
    Array.from({ length: 2000 }, (_, i) => `{"id":${i},"name":"user_${i}"}`).join('\n'),
  ).subarray(0, 50_000);
  const zstdDict = zstdTrainDictionary(
    Array.from({ length: 100 }, (_, i) => Buffer.from(`{"id":${i},"name":"user_${i}"}`)),
  );
  const brotliDict = data.subarray(0, 1024);

  type Factory = () => TransformStream<Chunk, Uint8Array>;
  const CODECS: {
    name: string;
    compressStream: Factory;
    decompressStream: Factory;
    compress: (data: Uint8Array) => Uint8Array;
    decompress: (data: Uint8Array) => Uint8Array;
  }[] = [
    {
      name: 'zstd',
      compressStream: () => createZstdCompressStream(),
      decompressStream: () => createZstdDecompressStream(),
      compress: (d) => zstdCompress(d),
      decompress: (d) => zstdDecompress(d),
    },
    {
      name: 'zstd with dictionary',
      compressStream: () => createZstdCompressDictStream(zstdDict),
      decompressStream: () => createZstdDecompressDictStream(zstdDict),
      compress: (d) => zstdCompressWithDict(d, zstdDict),
      decompress: (d) => zstdDecompressWithDict(d, zstdDict),
    },
    {
      name: 'gzip',
      compressStream: () => createGzipCompressStream(),
      decompressStream: () => createGzipDecompressStream(),
      compress: (d) => gzipCompress(d),
      decompress: (d) => gzipDecompress(d),
    },
    {
      name: 'deflate',
      compressStream: () => createDeflateCompressStream(),
      decompressStream: () => createDeflateDecompressStream(),
      compress: (d) => deflateCompress(d),
      decompress: (d) => deflateDecompress(d),
    },
    {
      name: 'brotli',
      compressStream: () => createBrotliCompressStream(),
      decompressStream: () => createBrotliDecompressStream(),
      compress: (d) => brotliCompress(d),
      decompress: (d) => brotliDecompress(d),
    },
    {
      name: 'brotli with dictionary',
      compressStream: () => createBrotliCompressDictStream(brotliDict),
      decompressStream: () => createBrotliDecompressDictStream(brotliDict),
      compress: (d) => brotliCompressWithDict(d, brotliDict),
      decompress: (d) => brotliDecompressWithDict(d, brotliDict),
    },
    {
      name: 'lz4',
      compressStream: () => createLz4CompressStream(),
      decompressStream: () => createLz4DecompressStream(),
      compress: (d) => lz4Compress(d),
      decompress: (d) => lz4Decompress(d),
    },
  ];

  describe.each(CODECS)('$name', ({ compressStream, decompressStream, compress, decompress }) => {
    it.each(CHUNK_KINDS)('should compress %s chunks byte for byte', async (kind) => {
      const chunks = await readChunks(
        streamOf(toChunks(data, 4096, kind)).pipeThrough(compressStream()),
      );
      expect(Buffer.from(decompress(Buffer.concat(chunks))).equals(data)).toBe(true);
    });

    it.each(CHUNK_KINDS)('should decompress %s chunks byte for byte', async (kind) => {
      const chunks = await readChunks(
        streamOf(toChunks(compress(data), 64, kind)).pipeThrough(decompressStream()),
      );
      expect(Buffer.concat(chunks).equals(data)).toBe(true);
    });

    it('should error on a chunk that is not binary data', async () => {
      const transform = compressStream();
      const writable: WritableStream<unknown> = transform.writable;
      const written = streamOf(['not bytes']).pipeTo(writable);
      const read = readChunks(transform.readable);
      await expect(read).rejects.toBeInstanceOf(TypeError);
      await expect(read).rejects.toThrow('chunk must be an ArrayBuffer or ArrayBufferView');
      await expect(written).rejects.toBeInstanceOf(TypeError);
    });
  });

  it('should accept an ArrayBuffer from another realm', async () => {
    // Such as the ArrayBuffer of a Buffer that Node.js returns to code that
    // runs in a vm context: instanceof ArrayBuffer is false for it.
    const compressed = zstdCompress(data);
    const foreign: unknown = runInNewContext(`new ArrayBuffer(${compressed.byteLength})`);
    if (!isArrayBuffer(foreign)) throw new Error('expected an ArrayBuffer');
    expect(foreign).not.toBeInstanceOf(ArrayBuffer);
    new Uint8Array(foreign).set(compressed);

    const chunks = await readChunks(streamOf([foreign]).pipeThrough(createZstdDecompressStream()));
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
  });
});

describe('Web stream output', () => {
  // A reader may transfer an output chunk to a worker. The chunks are plain
  // Uint8Arrays, each with an ArrayBuffer of its own: views of the native
  // output, which V8 allocates up to 2 MiB, or copies of larger output,
  // which stays in the memory of the addon. Node.js marks such external
  // memory as untransferable, so a view of it could not be transferred
  // there (DataCloneError).
  it.each([
    ['compress', () => createGzipCompressStream(), (d: Uint8Array) => d, gzipDecompress],
    ['decompress', () => createZstdDecompressStream(), zstdCompress, (d: Uint8Array) => d],
  ])('should %s into chunks that can be transferred', async (_, stream, prepare, read) => {
    const data = Buffer.from('Hello, comprs streaming output! '.repeat(1000));
    const chunks = await readChunks(streamOf([prepare(data)]).pipeThrough(stream()));
    for (const chunk of chunks) {
      expect(Object.getPrototypeOf(chunk)).toBe(Uint8Array.prototype);
    }
    const moved = chunks.map((chunk) => {
      const { buffer } = chunk;
      if (!isArrayBuffer(buffer)) throw new Error('expected an ArrayBuffer');
      return structuredClone(chunk, { transfer: [buffer] });
    });

    expect(chunks.every((chunk) => chunk.byteLength === 0)).toBe(true);
    expect(Buffer.from(read(Buffer.concat(moved))).equals(data)).toBe(true);
  });

  // The context returns the decompressed data from one transform() call: in
  // memory that V8 allocates at 2 MiB, which the stream enqueues as a view
  // (VIEW_LIMIT in src/streams.ts mirrors SYNC_COPY_LIMIT in
  // crates/core/src/convert.rs), and in the memory of the addon above it,
  // which the stream copies. The first case fails if SYNC_COPY_LIMIT drops
  // below 2 MiB and the second if VIEW_LIMIT rises above it, as the stream
  // would then enqueue a view of external memory.
  it.each([
    ['of 2 MiB', 2 * 1024 * 1024],
    ['larger than 2 MiB', 2 * 1024 * 1024 + 1],
  ])('should emit output %s in a chunk that can be transferred', async (_, size) => {
    const data = Buffer.alloc(size, 7);
    const stream = streamOf([zstdCompress(data)]).pipeThrough(createZstdDecompressStream());
    const [chunk, ...rest] = await readChunks(stream);
    if (chunk === undefined) throw new Error('expected a chunk');
    expect(rest).toEqual([]);
    expect(chunk.byteLength).toBe(size);
    expect(Object.getPrototypeOf(chunk)).toBe(Uint8Array.prototype);
    const { buffer } = chunk;
    if (!isArrayBuffer(buffer)) throw new Error('expected an ArrayBuffer');
    const moved = structuredClone(chunk, { transfer: [buffer] });
    expect(chunk.byteLength).toBe(0);
    expect(Buffer.from(moved.buffer, moved.byteOffset, moved.byteLength).equals(data)).toBe(true);
  });
});

describe('LZ4 decompression streams', () => {
  // About 730 KiB of text records, in three blocks of up to 256 KiB.
  const lines = Array.from({ length: 40_000 }, (_, i) => `record ${i}: ${(i * 7919) % 10007}\n`);
  const data = Buffer.from(lines.join(''));
  const frame = lz4Compress(data);

  // They emit each block once all of it has arrived, without waiting for
  // the end of the input.
  it.each([
    ['createLz4DecompressStream()', () => createLz4DecompressStream()],
    ['createDecompressStream()', () => createDecompressStream()],
  ])('%s should emit output before the input ends', async (_label, create) => {
    const stream = create();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const half = frame.length >> 1;
    const written = writer.write(frame.subarray(0, half));
    const first = await reader.read();
    await written;
    if (first.done) throw new Error('the stream ended early');
    expect(first.value.byteLength).toBeGreaterThan(0);

    const ended = writer.write(frame.subarray(half)).then(() => writer.close());
    const output = [first.value];
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      output.push(result.value);
    }
    await ended;
    expect(Buffer.concat(output).equals(data)).toBe(true);
  });

  it('should error on the chunk that holds data after the last frame', async () => {
    const stream = createLz4DecompressStream();
    const writer = stream.writable.getWriter();
    const output = readChunks(stream.readable);
    await writer.write(frame);
    await expect(writer.write(Buffer.from('garbage'))).rejects.toThrow(
      'lz4 stream decompress failed: unexpected data after the end of a frame',
    );
    await expect(output).rejects.toThrow('unexpected data after the end of a frame');
  });
});

/**
 * Read from `reader` until `length` bytes have arrived, and return them.
 * Fails unless they arrive within `ms` milliseconds.
 */
async function readBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  length: number,
  ms = 2000,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${received} of ${length} bytes in ${ms} ms`)), ms);
  });
  try {
    while (received < length) {
      const result = await Promise.race([reader.read(), timeout]);
      if (result.done) throw new Error(`the stream ended after ${received} of ${length} bytes`);
      chunks.push(result.value);
      received += result.value.byteLength;
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

/** A compression context that flushes. */
interface FlushingContext {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
}

describe('decompression streams', () => {
  // 100,000 bytes of text: a message that a stream carries in one chunk.
  const message = Buffer.from(
    Array.from({ length: 4000 }, (_, i) => `line ${i}: the quick brown fox\n`)
      .join('')
      .slice(0, 100_000),
  );

  // A chunk that ends mid-stream, as a stream that is flushed after each
  // message carries it: the stream emits all of its output without more
  // input or the end of the input (#704).
  it.each<[string, () => TransformStream<Uint8Array, Uint8Array>, () => FlushingContext]>([
    ['createZstdDecompressStream()', createZstdDecompressStream, () => new ZstdCompressContext()],
    ['createGzipDecompressStream()', createGzipDecompressStream, () => new GzipCompressContext()],
    [
      'createDeflateDecompressStream()',
      createDeflateDecompressStream,
      () => new DeflateCompressContext(),
    ],
    [
      'createBrotliDecompressStream()',
      createBrotliDecompressStream,
      () => new BrotliCompressContext(5),
    ],
    ['createLz4DecompressStream()', createLz4DecompressStream, () => new Lz4CompressContext()],
    ['createDecompressStream() for zstd', createDecompressStream, () => new ZstdCompressContext()],
    ['createDecompressStream() for gzip', createDecompressStream, () => new GzipCompressContext()],
    [
      'createDecompressStream() for brotli',
      createDecompressStream,
      () => new BrotliCompressContext(5),
    ],
    ['createDecompressStream() for lz4', createDecompressStream, () => new Lz4CompressContext()],
  ])(
    '%s should emit all the output of a chunk that ends mid-stream',
    async (_label, create, compressor) => {
      const context = compressor();
      const chunk = Buffer.concat([context.transform(message), context.flush()]);
      const stream = create();
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      const written = writer.write(chunk);
      expect((await readBytes(reader, message.length)).equals(message)).toBe(true);
      await written;
      await reader.cancel();
    },
  );
});
