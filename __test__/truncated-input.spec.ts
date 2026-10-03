import type { Transform } from 'node:stream';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import {
  BrotliDecompressContext,
  BrotliDecompressDictContext,
  brotliCompress,
  brotliCompressWithDict,
  brotliDecompress,
  brotliDecompressAsync,
  brotliDecompressWithCapacity,
  brotliDecompressWithDict,
  DeflateDecompressContext,
  decompress,
  decompressAsync,
  deflateCompress,
  deflateDecompress,
  deflateDecompressAsync,
  deflateDecompressWithCapacity,
  deflateDecompressWithCapacityAsync,
  GzipDecompressContext,
  gzipCompress,
  gzipDecompress,
  gzipDecompressAsync,
  Lz4DecompressContext,
  lz4Decompress,
  lz4DecompressAsync,
  ZstdDecompressContext,
  ZstdDecompressDictContext,
  zstdCompress,
  zstdCompressWithDict,
  zstdDecompress,
  zstdDecompressAsync,
  zstdDecompressWithCapacity,
  zstdDecompressWithDict,
  zstdTrainDictionary,
} from '../index.js';
import {
  createBrotliDecompressDictTransform,
  createBrotliDecompressTransform,
  createDecompressTransform,
  createDeflateDecompressTransform,
  createGzipDecompressTransform,
  createLz4DecompressTransform,
  createZstdDecompressDictTransform,
  createZstdDecompressTransform,
} from '../node.js';
import {
  createBrotliDecompressDictStream,
  createBrotliDecompressStream,
  createDecompressStream,
  createDeflateDecompressStream,
  createGzipDecompressStream,
  createLz4DecompressStream,
  createZstdDecompressDictStream,
  createZstdDecompressStream,
} from '../streams.js';

const data = Buffer.from(Array.from({ length: 2000 }, (_, i) => `line ${i}\n`).join(''));
const zstdDict = zstdTrainDictionary(
  Array.from({ length: 20 }, (_, i) => Buffer.from(`line ${i}\n`.repeat(50))),
  4096,
);
const brotliDict = Buffer.from('line 0\nline 1\nline 2\n'.repeat(10));

const truncated = (format: string): string =>
  `${format} stream is truncated: unexpected end of input`;

/** Pipe `input` as a single chunk through a Web TransformStream. */
async function pipeWeb(
  transform: TransformStream<Uint8Array, Uint8Array>,
  input: Uint8Array,
): Promise<Buffer> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      if (input.length > 0) controller.enqueue(new Uint8Array(input));
      controller.close();
    },
  });
  const chunks: Uint8Array[] = [];
  const reader = source.pipeThrough(transform).getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Pipe `input` as a single chunk through a Node.js Transform. */
async function pipeNode(transform: Transform, input: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline(Readable.from(input.length > 0 ? [input] : []), transform, sink);
  return Buffer.concat(chunks);
}

interface StreamCase {
  name: string;
  compressed: Buffer;
  web: () => TransformStream<Uint8Array, Uint8Array>;
  node: () => Transform;
  /** Lengths to cut `compressed` to. */
  cuts: number[];
  /**
   * Expected error. gzip reports input cut inside a member as a checksum
   * mismatch, so any error is accepted there.
   */
  error?: string;
}

const cutsOf = (compressed: Buffer): number[] => [1, compressed.length >> 1, compressed.length - 1];

function streamCase(
  name: string,
  compressed: Buffer,
  web: () => TransformStream<Uint8Array, Uint8Array>,
  node: () => Transform,
  error?: string,
): StreamCase {
  return { name, compressed, web, node, cuts: cutsOf(compressed), ...(error ? { error } : {}) };
}

const zstdCompressed = zstdCompress(data);
const brotliCompressed = brotliCompress(data);
const gzipCompressed = gzipCompress(data);

const streamCases: StreamCase[] = [
  streamCase(
    'zstd',
    zstdCompressed,
    () => createZstdDecompressStream(),
    () => createZstdDecompressTransform(),
    truncated('zstd'),
  ),
  streamCase(
    'zstd with dictionary',
    zstdCompressWithDict(data, zstdDict),
    () => createZstdDecompressDictStream(zstdDict),
    () => createZstdDecompressDictTransform(zstdDict),
    truncated('zstd'),
  ),
  streamCase(
    'brotli',
    brotliCompressed,
    () => createBrotliDecompressStream(),
    () => createBrotliDecompressTransform(),
    truncated('brotli'),
  ),
  streamCase(
    'brotli with dictionary',
    brotliCompressWithDict(data, brotliDict),
    () => createBrotliDecompressDictStream(brotliDict),
    () => createBrotliDecompressDictTransform(brotliDict),
    truncated('brotli'),
  ),
  streamCase(
    'deflate',
    deflateCompress(data),
    () => createDeflateDecompressStream(),
    () => createDeflateDecompressTransform(),
    truncated('deflate'),
  ),
  streamCase(
    'gzip',
    gzipCompressed,
    () => createGzipDecompressStream(),
    () => createGzipDecompressTransform(),
  ),
  // Auto-detection needs a few bytes, so these cuts start after the magic.
  {
    ...streamCase(
      'auto-detected zstd',
      zstdCompressed,
      () => createDecompressStream(),
      () => createDecompressTransform(),
      truncated('zstd'),
    ),
    cuts: cutsOf(zstdCompressed).slice(1),
  },
  {
    ...streamCase(
      'auto-detected brotli',
      brotliCompressed,
      () => createDecompressStream(),
      () => createDecompressTransform(),
      truncated('brotli'),
    ),
    cuts: cutsOf(brotliCompressed).slice(1),
  },
  {
    ...streamCase(
      'auto-detected gzip',
      gzipCompressed,
      () => createDecompressStream(),
      () => createDecompressTransform(),
    ),
    cuts: cutsOf(gzipCompressed).slice(1),
  },
];

describe.each(streamCases)(
  '$name decompression stream',
  ({ compressed, web, node, cuts, error }) => {
    it('should decompress complete input', async () => {
      expect(await pipeWeb(web(), compressed)).toEqual(data);
      expect(await pipeNode(node(), compressed)).toEqual(data);
    });

    it.each(cuts)('should reject input cut to %i bytes in a Web stream', async (length) => {
      await expect(pipeWeb(web(), compressed.subarray(0, length))).rejects.toThrow(error);
    });

    it.each(cuts)('should reject input cut to %i bytes in a Node transform', async (length) => {
      await expect(pipeNode(node(), compressed.subarray(0, length))).rejects.toThrow(error);
    });
  },
);

describe('gzip decompression stream', () => {
  it('should report input cut inside the header as truncated', async () => {
    await expect(
      pipeWeb(createGzipDecompressStream(), gzipCompressed.subarray(0, 5)),
    ).rejects.toThrow(truncated('gzip'));
    await expect(
      pipeNode(createGzipDecompressTransform(), gzipCompressed.subarray(0, 5)),
    ).rejects.toThrow(truncated('gzip'));
  });
});

// ---------------------------------------------------------------------------
// finish() on the decompression contexts
// ---------------------------------------------------------------------------

interface DecompressContext {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  finish(): Uint8Array;
}

const contextCases: [string, Buffer, () => DecompressContext, string][] = [
  ['ZstdDecompressContext', zstdCompressed, () => new ZstdDecompressContext(), 'zstd'],
  [
    'ZstdDecompressDictContext',
    zstdCompressWithDict(data, zstdDict),
    () => new ZstdDecompressDictContext(zstdDict),
    'zstd',
  ],
  ['BrotliDecompressContext', brotliCompressed, () => new BrotliDecompressContext(), 'brotli'],
  [
    'BrotliDecompressDictContext',
    brotliCompressWithDict(data, brotliDict),
    () => new BrotliDecompressDictContext(brotliDict),
    'brotli',
  ],
  [
    'DeflateDecompressContext',
    deflateCompress(data),
    () => new DeflateDecompressContext(),
    'deflate',
  ],
];

describe.each(contextCases)('%s.finish()', (_name, compressed, create, format) => {
  it('should return the remaining output of a complete stream', () => {
    const ctx = create();
    const output = Buffer.concat([ctx.transform(compressed), ctx.flush(), ctx.finish()]);
    expect(output).toEqual(data);
  });

  it.each([0, 1, compressed.length >> 1, compressed.length - 1])(
    'should throw for input cut to %i bytes',
    (length) => {
      const ctx = create();
      ctx.transform(compressed.subarray(0, length));
      ctx.flush();
      expect(() => ctx.finish()).toThrow(truncated(format));
    },
  );

  it('should end the stream', () => {
    const ctx = create();
    ctx.transform(compressed);
    ctx.finish();
    expect(() => ctx.transform(compressed)).toThrow(/already finished/);
    expect(() => ctx.finish()).toThrow(/already finished/);
  });
});

// ---------------------------------------------------------------------------
// One-shot raw deflate
// ---------------------------------------------------------------------------

describe('one-shot deflate decompression', () => {
  const compressed = deflateCompress(data);
  const cuts = [1, compressed.length >> 1, compressed.length - 1];

  it.each(cuts)('should reject input cut to %i bytes', async (length) => {
    const input = compressed.subarray(0, length);
    expect(() => deflateDecompress(input)).toThrow(truncated('deflate'));
    expect(() => deflateDecompressWithCapacity(input, data.length)).toThrow(truncated('deflate'));
    await expect(deflateDecompressAsync(input)).rejects.toThrow(truncated('deflate'));
    await expect(deflateDecompressWithCapacityAsync(input, data.length)).rejects.toThrow(
      truncated('deflate'),
    );
  });
});

// ---------------------------------------------------------------------------
// One-shot zstd
// ---------------------------------------------------------------------------

describe('one-shot zstd decompression', () => {
  const dictCompressed = zstdCompressWithDict(data, zstdDict);

  it.each(cutsOf(zstdCompressed))('should reject input cut to %i bytes', async (length) => {
    const input = zstdCompressed.subarray(0, length);
    expect(() => zstdDecompress(input)).toThrow(truncated('zstd'));
    expect(() => zstdDecompressWithCapacity(input, data.length)).toThrow(truncated('zstd'));
    await expect(zstdDecompressAsync(input)).rejects.toThrow(truncated('zstd'));
  });

  it.each(cutsOf(zstdCompressed).slice(1))(
    'auto-detection should reject input cut to %i bytes',
    async (length) => {
      const input = zstdCompressed.subarray(0, length);
      expect(() => decompress(input)).toThrow(truncated('zstd'));
      await expect(decompressAsync(input)).rejects.toThrow(truncated('zstd'));
    },
  );

  it.each(cutsOf(dictCompressed))('should reject dictionary input cut to %i bytes', (length) => {
    const input = dictCompressed.subarray(0, length);
    expect(() => zstdDecompressWithDict(input, zstdDict)).toThrow(truncated('zstd'));
  });

  it('should reject a complete frame followed by a truncated one', () => {
    const input = Buffer.concat([zstdCompressed, zstdCompressed.subarray(0, 10)]);
    expect(() => zstdDecompress(input)).toThrow(truncated('zstd'));
  });
});

// ---------------------------------------------------------------------------
// Empty input: no format has a valid zero-length encoding
// ---------------------------------------------------------------------------

describe('empty input', () => {
  const empty = Buffer.alloc(0);

  it.each<[string, (input: Buffer) => Buffer, string]>([
    ['zstdDecompress', zstdDecompress, 'zstd'],
    ['zstdDecompressWithCapacity', (input) => zstdDecompressWithCapacity(input, 1024), 'zstd'],
    ['zstdDecompressWithDict', (input) => zstdDecompressWithDict(input, zstdDict), 'zstd'],
    ['gzipDecompress', gzipDecompress, 'gzip'],
    ['deflateDecompress', deflateDecompress, 'deflate'],
    ['brotliDecompress', brotliDecompress, 'brotli'],
    [
      'brotliDecompressWithCapacity',
      (input) => brotliDecompressWithCapacity(input, 1024),
      'brotli',
    ],
    ['brotliDecompressWithDict', (input) => brotliDecompressWithDict(input, brotliDict), 'brotli'],
    ['lz4Decompress', lz4Decompress, 'lz4'],
  ])('%s should throw', (_name, fn, format) => {
    expect(() => fn(empty)).toThrow(truncated(format));
  });

  it.each<[string, (input: Buffer) => Promise<Buffer>, string]>([
    ['zstdDecompressAsync', zstdDecompressAsync, 'zstd'],
    ['gzipDecompressAsync', gzipDecompressAsync, 'gzip'],
    ['deflateDecompressAsync', deflateDecompressAsync, 'deflate'],
    ['brotliDecompressAsync', brotliDecompressAsync, 'brotli'],
    ['lz4DecompressAsync', lz4DecompressAsync, 'lz4'],
  ])('%s should reject', async (_name, fn, format) => {
    await expect(fn(empty)).rejects.toThrow(truncated(format));
  });

  it('auto-detect decompression should throw', async () => {
    expect(() => decompress(empty)).toThrow(/unable to detect compression format/);
    await expect(decompressAsync(empty)).rejects.toThrow(/unable to detect compression format/);
  });

  it.each<[string, () => TransformStream<Uint8Array, Uint8Array>, () => Transform, string]>([
    ['zstd', () => createZstdDecompressStream(), () => createZstdDecompressTransform(), 'zstd'],
    ['gzip', () => createGzipDecompressStream(), () => createGzipDecompressTransform(), 'gzip'],
    [
      'deflate',
      () => createDeflateDecompressStream(),
      () => createDeflateDecompressTransform(),
      'deflate',
    ],
    [
      'brotli',
      () => createBrotliDecompressStream(),
      () => createBrotliDecompressTransform(),
      'brotli',
    ],
    ['lz4', () => createLz4DecompressStream(), () => createLz4DecompressTransform(), 'lz4'],
  ])('%s streams should reject', async (_name, web, node, format) => {
    await expect(pipeWeb(web(), empty)).rejects.toThrow(truncated(format));
    await expect(pipeNode(node(), empty)).rejects.toThrow(truncated(format));
  });

  it('auto-detect streams should reject', async () => {
    await expect(pipeWeb(createDecompressStream(), empty)).rejects.toThrow(
      /unable to detect compression format/,
    );
    await expect(pipeNode(createDecompressTransform(), empty)).rejects.toThrow(
      /unable to detect compression format/,
    );
  });

  it('contexts should throw when finished', () => {
    expect(() => new GzipDecompressContext().finish()).toThrow(truncated('gzip'));
    expect(() => new DeflateDecompressContext().finish()).toThrow(truncated('deflate'));
    expect(() => new ZstdDecompressContext().finish()).toThrow(truncated('zstd'));
    expect(() => new BrotliDecompressContext().finish()).toThrow(truncated('brotli'));
    expect(() => new Lz4DecompressContext().flush()).toThrow(truncated('lz4'));
  });
});
