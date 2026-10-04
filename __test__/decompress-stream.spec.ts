import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { brotliCompress, gzipCompress, lz4Compress, zstdCompress } from '../index.js';
import { createDecompressTransform } from '../node.js';
import { createDecompressStream } from '../streams.js';
import { CHUNK_KINDS, readChunks, streamOf, toChunks } from './chunk-fixtures.js';
import { lz4LegacyFrame, pseudoRandomBytes, ROWS, skippableFrame } from './detect-fixtures.js';

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

describe('createDecompressStream chunk types', () => {
  const zstd = zstdCompress(original);
  const ab = zstd.buffer.slice(zstd.byteOffset, zstd.byteOffset + zstd.byteLength);

  it('should decompress ArrayBuffer chunks split inside the magic number', async () => {
    const chunks = await readChunks(
      streamOf([ab.slice(0, 2), ab.slice(2)]).pipeThrough(createDecompressStream()),
    );
    expect(Buffer.concat(chunks)).toEqual(original);
  });

  it('should decompress a single DataView chunk', async () => {
    const chunks = await readChunks(
      streamOf([new DataView(ab)]).pipeThrough(createDecompressStream()),
    );
    expect(Buffer.concat(chunks)).toEqual(original);
  });

  const FORMATS: [string, Buffer][] = [
    ['zstd', zstd],
    ['gzip', gzipCompress(original)],
    ['brotli', brotliCompress(original)],
    ['lz4', lz4Compress(original)],
  ];

  describe.each(FORMATS)('%s', (_format, compressed) => {
    it.each(CHUNK_KINDS)('should decompress 2-byte %s chunks byte for byte', async (kind) => {
      const chunks = await readChunks(
        streamOf(toChunks(compressed, 2, kind)).pipeThrough(createDecompressStream()),
      );
      expect(Buffer.concat(chunks)).toEqual(original);
    });
  });

  it('should not keep a view of a chunk while it detects the format', async () => {
    // The writer reuses one buffer for every chunk, as soon as each write
    // has been accepted.
    const scratch = new Uint8Array(3);
    const transform = createDecompressStream();
    const output = readChunks(transform.readable);
    const writer = transform.writable.getWriter();
    for (let i = 0; i < zstd.length; i += scratch.length) {
      const piece = zstd.subarray(i, i + scratch.length);
      scratch.set(piece);
      await writer.write(scratch.subarray(0, piece.length));
    }
    await writer.close();
    expect(Buffer.concat(await output)).toEqual(original);
  });

  it('should error on a chunk that is not binary data', async () => {
    const transform = createDecompressStream();
    const writable: WritableStream<unknown> = transform.writable;
    const written = streamOf(['not bytes']).pipeTo(writable);
    const read = readChunks(transform.readable);
    await expect(read).rejects.toBeInstanceOf(TypeError);
    await expect(read).rejects.toThrow('chunk must be an ArrayBuffer or ArrayBufferView');
    await expect(written).rejects.toBeInstanceOf(TypeError);
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

// ---------------------------------------------------------------------------
// Detection in the auto-detecting streams
// ---------------------------------------------------------------------------

/** Decompress `input`, split into chunks of `chunkSize` bytes, with a stream. */
type Decompressor = (input: Buffer, chunkSize: number) => Promise<Buffer>;

/** The first output of a stream that receives `input` but never ends. */
type FirstOutput = (input: Buffer) => Promise<Buffer>;

const STREAMS: [string, Decompressor, FirstOutput][] = [
  [
    'createDecompressStream',
    (input, chunkSize) =>
      collectStream(toChunkedStream(input, chunkSize).pipeThrough(createDecompressStream())),
    async (input) => {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(input));
        },
      });
      const { value } = await source.pipeThrough(createDecompressStream()).getReader().read();
      return Buffer.from(value ?? []);
    },
  ],
  [
    'createDecompressTransform',
    (input, chunkSize) =>
      collectTransform(toChunkedReadable(input, chunkSize), createDecompressTransform()),
    (input) => {
      const transform = createDecompressTransform();
      const output = new Promise<Buffer>((resolve, reject) => {
        transform.once('data', resolve);
        transform.once('error', reject);
      });
      transform.write(input);
      return output.finally(() => transform.destroy());
    },
  ],
];

const content = ROWS.subarray(0, 8000);
const incompressible = pseudoRandomBytes(1, 66 * 1024);
const legacyContent = Buffer.from('legacy LZ4 frame, as lz4 -l writes it');
const skippable = skippableFrame(Buffer.from('metadata'));

const DETECTION_CASES: [string, Buffer, Buffer][] = [
  ['zstd', zstdCompress(content), content],
  ['gzip', gzipCompress(content), content],
  ['brotli', brotliCompress(content), content],
  ['lz4', lz4Compress(content), content],
  ['an empty brotli stream', brotliCompress(Buffer.alloc(0)), Buffer.alloc(0)],
  ['brotli of data that does not compress', brotliCompress(incompressible), incompressible],
  ['zstd after a skippable frame', Buffer.concat([skippable, zstdCompress(content)]), content],
  ['lz4 after a skippable frame', Buffer.concat([skippable, lz4Compress(content)]), content],
  ['an LZ4 legacy frame', lz4LegacyFrame(legacyContent), legacyContent],
];

const CHUNK_SIZES = [1, 3, 64, 1024, 100 * 1024];

describe.each(STREAMS)('%s format detection', (_name, decompressChunks, firstOutput) => {
  describe.each(DETECTION_CASES)('%s', (_case, compressed, expected) => {
    // 1-byte chunks of the 66 KiB input take about 2 s through Web Streams.
    it.each(CHUNK_SIZES)(
      'should decompress it in %i-byte chunks',
      { timeout: 30_000 },
      async (chunkSize) => {
        expect(await decompressChunks(compressed, chunkSize)).toEqual(expected);
      },
    );
  });

  it('should decompress the issue example of brotli in small chunks', async () => {
    const compressed = brotliCompress(ROWS);
    for (const chunkSize of [4, 16, 64]) {
      expect(await decompressChunks(compressed, chunkSize)).toEqual(ROWS);
    }
  });

  it('should detect brotli that does not compress once 64 KiB have arrived', async () => {
    const compressed = brotliCompress(incompressible);
    const output = await firstOutput(compressed.subarray(0, 64 * 1024));
    expect(output.length).toBeGreaterThan(0);
    expect(output).toEqual(incompressible.subarray(0, output.length));
  });

  it('should give up on an unknown format once 64 KiB have arrived', async () => {
    const data = Buffer.from('this is not compressed data at all. '.repeat(2000));
    await expect(firstOutput(data.subarray(0, 64 * 1024))).rejects.toThrow(
      /unable to detect compression format/,
    );
  });

  it('should reject an unknown format at the end of shorter input', async () => {
    const data = Buffer.from('this is not compressed data at all');
    for (const chunkSize of [1, data.length]) {
      await expect(decompressChunks(data, chunkSize)).rejects.toThrow(
        /unable to detect compression format/,
      );
    }
  });
});
