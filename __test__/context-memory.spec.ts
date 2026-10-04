import { once } from 'node:events';
import { Readable, type Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser/streaming.js ships without type declarations; its
// classes mirror the native ones typed below.
import * as browserStreaming from '../browser/streaming.js';
import {
  BrotliCompressContext,
  BrotliCompressDictContext,
  BrotliDecompressContext,
  BrotliDecompressDictContext,
  brotliCompress,
  brotliCompressWithDict,
  DeflateCompressContext,
  DeflateDecompressContext,
  deflateCompress,
  GzipCompressContext,
  GzipDecompressContext,
  gzipCompress,
  Lz4CompressContext,
  Lz4DecompressContext,
  lz4Compress,
  ZstdCompressContext,
  ZstdCompressDictContext,
  ZstdDecompressContext,
  ZstdDecompressDictContext,
  zstdCompress,
  zstdCompressWithDict,
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

const data = Buffer.from('stream context memory '.repeat(200));
const dict = Buffer.from('a dictionary for stream contexts '.repeat(20));

/** The methods that every stream context class has. */
interface Context extends Disposable {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  finish(): Uint8Array;
  close(): void;
}

/** A stream context class, with the stream name in its errors. */
interface ContextCase {
  name: string;
  stream: string;
  prototype: Context;
  create: () => Context;
  /** Input that the context accepts. */
  input: Buffer;
  createStream: () => TransformStream<Uint8Array, Uint8Array>;
  createTransform: () => Transform;
  decompresses: boolean;
}

const cases: ContextCase[] = [
  {
    name: 'ZstdCompressContext',
    stream: 'zstd stream',
    prototype: ZstdCompressContext.prototype,
    create: () => new ZstdCompressContext(),
    input: data,
    createStream: () => createZstdCompressStream(),
    createTransform: () => createZstdCompressTransform(),
    decompresses: false,
  },
  {
    name: 'ZstdDecompressContext',
    stream: 'zstd stream',
    prototype: ZstdDecompressContext.prototype,
    create: () => new ZstdDecompressContext(),
    input: zstdCompress(data),
    createStream: () => createZstdDecompressStream(),
    createTransform: () => createZstdDecompressTransform(),
    decompresses: true,
  },
  {
    name: 'ZstdCompressDictContext',
    stream: 'zstd stream',
    prototype: ZstdCompressDictContext.prototype,
    create: () => new ZstdCompressDictContext(dict),
    input: data,
    createStream: () => createZstdCompressDictStream(dict),
    createTransform: () => createZstdCompressDictTransform(dict),
    decompresses: false,
  },
  {
    name: 'ZstdDecompressDictContext',
    stream: 'zstd stream',
    prototype: ZstdDecompressDictContext.prototype,
    create: () => new ZstdDecompressDictContext(dict),
    input: zstdCompressWithDict(data, dict),
    createStream: () => createZstdDecompressDictStream(dict),
    createTransform: () => createZstdDecompressDictTransform(dict),
    decompresses: true,
  },
  {
    name: 'GzipCompressContext',
    stream: 'gzip stream',
    prototype: GzipCompressContext.prototype,
    create: () => new GzipCompressContext(),
    input: data,
    createStream: () => createGzipCompressStream(),
    createTransform: () => createGzipCompressTransform(),
    decompresses: false,
  },
  {
    name: 'GzipDecompressContext',
    stream: 'gzip stream',
    prototype: GzipDecompressContext.prototype,
    create: () => new GzipDecompressContext(),
    input: gzipCompress(data),
    createStream: () => createGzipDecompressStream(),
    createTransform: () => createGzipDecompressTransform(),
    decompresses: true,
  },
  {
    name: 'DeflateCompressContext',
    stream: 'deflate stream',
    prototype: DeflateCompressContext.prototype,
    create: () => new DeflateCompressContext(),
    input: data,
    createStream: () => createDeflateCompressStream(),
    createTransform: () => createDeflateCompressTransform(),
    decompresses: false,
  },
  {
    name: 'DeflateDecompressContext',
    stream: 'deflate stream',
    prototype: DeflateDecompressContext.prototype,
    create: () => new DeflateDecompressContext(),
    input: deflateCompress(data),
    createStream: () => createDeflateDecompressStream(),
    createTransform: () => createDeflateDecompressTransform(),
    decompresses: true,
  },
  {
    name: 'BrotliCompressContext',
    stream: 'brotli stream',
    prototype: BrotliCompressContext.prototype,
    create: () => new BrotliCompressContext(),
    input: data,
    createStream: () => createBrotliCompressStream(),
    createTransform: () => createBrotliCompressTransform(),
    decompresses: false,
  },
  {
    name: 'BrotliDecompressContext',
    stream: 'brotli stream',
    prototype: BrotliDecompressContext.prototype,
    create: () => new BrotliDecompressContext(),
    input: brotliCompress(data),
    createStream: () => createBrotliDecompressStream(),
    createTransform: () => createBrotliDecompressTransform(),
    decompresses: true,
  },
  {
    name: 'BrotliCompressDictContext',
    stream: 'brotli dict stream',
    prototype: BrotliCompressDictContext.prototype,
    create: () => new BrotliCompressDictContext(dict),
    input: data,
    createStream: () => createBrotliCompressDictStream(dict),
    createTransform: () => createBrotliCompressDictTransform(dict),
    decompresses: false,
  },
  {
    name: 'BrotliDecompressDictContext',
    stream: 'brotli dict stream',
    prototype: BrotliDecompressDictContext.prototype,
    create: () => new BrotliDecompressDictContext(dict),
    input: brotliCompressWithDict(data, dict),
    createStream: () => createBrotliDecompressDictStream(dict),
    createTransform: () => createBrotliDecompressDictTransform(dict),
    decompresses: true,
  },
  {
    name: 'Lz4CompressContext',
    stream: 'lz4 stream',
    prototype: Lz4CompressContext.prototype,
    create: () => new Lz4CompressContext(),
    input: data,
    createStream: () => createLz4CompressStream(),
    createTransform: () => createLz4CompressTransform(),
    decompresses: false,
  },
  {
    name: 'Lz4DecompressContext',
    stream: 'lz4 stream',
    prototype: Lz4DecompressContext.prototype,
    create: () => new Lz4DecompressContext(),
    input: lz4Compress(data),
    createStream: () => createLz4DecompressStream(),
    createTransform: () => createLz4DecompressTransform(),
    decompresses: true,
  },
];

const decompressCases = cases.filter((c) => c.decompresses);

/** Not compressed with any format. */
const garbage = Buffer.from('this is not compressed data '.repeat(20));

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Native memory
// ---------------------------------------------------------------------------

describe('stream context memory', () => {
  it('is reported to V8, which collects abandoned contexts', async () => {
    // A zstd context allocates about 3.5 MiB once it compresses data. Unless
    // the context reports it, V8 sees only small objects, never collects
    // them, and the abandoned contexts pile up.
    let collected = 0;
    const registry = new FinalizationRegistry(() => {
      collected++;
    });
    for (let i = 0; i < 100 && collected === 0; i++) {
      const ctx = new ZstdCompressContext();
      ctx.transform(data);
      registry.register(ctx, i);
      // Let finalizers and FinalizationRegistry callbacks run, as a server
      // would between requests.
      if (i % 10 === 9) await new Promise(setImmediate);
    }
    expect(collected).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// close() and [Symbol.dispose]()
// ---------------------------------------------------------------------------

describe.each(cases)('$name', ({ stream, create, input }) => {
  it('should throw on every call after close()', () => {
    const ctx = create();
    ctx.transform(input.subarray(0, 10));
    ctx.close();
    expect(() => ctx.transform(input)).toThrow(`${stream} already closed`);
    expect(() => ctx.flush()).toThrow(`${stream} already closed`);
    expect(() => ctx.finish()).toThrow(`${stream} already closed`);
  });

  it('should allow close() more than once and after finish()', () => {
    const closed = create();
    closed.close();
    expect(() => closed.close()).not.toThrow();

    const finished = create();
    finished.transform(input);
    finished.flush();
    finished.finish();
    finished.close();
    expect(() => finished.transform(input)).toThrow(`${stream} already finished`);
  });

  it('should close at the end of a using declaration', () => {
    let disposed: Context | undefined;
    {
      using ctx = create();
      ctx.transform(input.subarray(0, 10));
      disposed = ctx;
    }
    expect(() => disposed?.flush()).toThrow(`${stream} already closed`);
    expect(disposed?.[Symbol.dispose]).toBe(disposed?.close);
  });
});

describe('Lz4DecompressContext.finish()', () => {
  const compressed = lz4Compress(data);

  it('should decompress the buffered input and end the stream', () => {
    const ctx = new Lz4DecompressContext();
    ctx.transform(compressed);
    expect(Buffer.compare(ctx.finish(), data)).toBe(0);
    expect(() => ctx.transform(compressed)).toThrow('lz4 stream already finished');
    expect(() => ctx.finish()).toThrow('lz4 stream already finished');
  });

  it('should return nothing after flush()', () => {
    const ctx = new Lz4DecompressContext();
    ctx.transform(compressed);
    expect(Buffer.compare(ctx.flush(), data)).toBe(0);
    expect(ctx.finish().byteLength).toBe(0);
  });

  it('should reject empty input', () => {
    expect(() => new Lz4DecompressContext().finish()).toThrow('lz4 stream is truncated');
  });
});

// ---------------------------------------------------------------------------
// Streams close their contexts
// ---------------------------------------------------------------------------

/** Read `stream` to its end. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (let result = await reader.read(); !result.done; result = await reader.read()) {
    chunks.push(result.value);
  }
  return Buffer.concat(chunks);
}

/** A Web stream that has transformed the start of `input` and waits for more. */
async function startStream(
  stream: TransformStream<Uint8Array, Uint8Array>,
  input: Buffer,
): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}> {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  // A pending read lets the stream take input. Aborting the stream rejects
  // it.
  reader.read().catch(() => {});
  await writer.write(input.subarray(0, 10));
  return { reader, writer };
}

describe.each(cases)('Web stream of $name', ({ prototype, input, createStream }) => {
  it('should close the context when the stream ends', async () => {
    const close = vi.spyOn(prototype, 'close');
    await collect(new Blob([input]).stream().pipeThrough(createStream()));
    expect(close).toHaveBeenCalled();
  });

  it('should close the context when the readable side is cancelled', async () => {
    const close = vi.spyOn(prototype, 'close');
    const { reader } = await startStream(createStream(), input);
    await reader.cancel();
    expect(close).toHaveBeenCalledOnce();
  });

  it('should close the context when the writable side is aborted', async () => {
    const close = vi.spyOn(prototype, 'close');
    const { writer } = await startStream(createStream(), input);
    await writer.abort(new Error('aborted'));
    expect(close).toHaveBeenCalledOnce();
  });
});

describe.each(decompressCases)('Web stream of $name', ({ prototype, createStream }) => {
  it('should close the context when decompression fails', async () => {
    const close = vi.spyOn(prototype, 'close');
    await expect(
      collect(new Blob([garbage]).stream().pipeThrough(createStream())),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalled();
  });
});

describe.each(cases)('Node.js Transform of $name', ({ prototype, input, createTransform }) => {
  it('should close the context when the stream ends', async () => {
    const close = vi.spyOn(prototype, 'close');
    const sink = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    await pipeline(Readable.from([input]), createTransform(), sink);
    expect(close).toHaveBeenCalled();
  });

  it('should close the context when the stream is destroyed', async () => {
    const close = vi.spyOn(prototype, 'close');
    const transform = createTransform();
    transform.write(input.subarray(0, 10));
    transform.destroy();
    await once(transform, 'close');
    expect(close).toHaveBeenCalledOnce();
  });
});

describe.each(decompressCases)('Node.js Transform of $name', ({ prototype, createTransform }) => {
  it('should close the context when decompression fails', async () => {
    const close = vi.spyOn(prototype, 'close');
    const sink = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    await expect(pipeline(Readable.from([garbage]), createTransform(), sink)).rejects.toThrow();
    expect(close).toHaveBeenCalled();
  });
});

describe('auto-detecting streams', () => {
  const compressed = zstdCompress(data);

  it('should close the detected context when a Web stream is cancelled', async () => {
    const close = vi.spyOn(ZstdDecompressContext.prototype, 'close');
    const { reader } = await startStream(createDecompressStream(), compressed);
    await reader.cancel();
    expect(close).toHaveBeenCalledOnce();
  });

  it('should cancel a Web stream before it detects the format', async () => {
    const stream = createDecompressStream();
    await expect(stream.readable.cancel()).resolves.toBeUndefined();
  });

  it('should close the detected context when a Node.js Transform is destroyed', async () => {
    const close = vi.spyOn(ZstdDecompressContext.prototype, 'close');
    const transform = createDecompressTransform();
    transform.write(compressed.subarray(0, 10));
    transform.destroy();
    await once(transform, 'close');
    expect(close).toHaveBeenCalledOnce();
  });

  it('should close the detected context when they end', async () => {
    const close = vi.spyOn(Lz4DecompressContext.prototype, 'close');
    const output = await collect(
      new Blob([lz4Compress(data)]).stream().pipeThrough(createDecompressStream()),
    );
    expect(Buffer.compare(output, data)).toBe(0);
    expect(close).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Browser adapters (browser/streaming.js), run against the native one-shot
// functions through the alias in vitest.config.mts
// ---------------------------------------------------------------------------

/** The adapter classes; dictionary contexts take the dictionary. */
type BrowserContexts = Record<string, new (dict?: Buffer) => Context>;
const adapters: BrowserContexts = browserStreaming;

describe.each(cases)('browser $name', ({ name, stream, input }) => {
  const create = (): Context => {
    const Adapter = adapters[name];
    if (!Adapter) throw new Error(`browser/streaming.js has no ${name}`);
    return new Adapter(name.includes('Dict') ? dict : undefined);
  };

  it('should throw on every call after close()', () => {
    const ctx = create();
    ctx.transform(input);
    ctx.close();
    expect(() => ctx.transform(input)).toThrow(`${stream} already closed`);
    expect(() => ctx.flush()).toThrow(`${stream} already closed`);
    expect(() => ctx.finish()).toThrow(`${stream} already closed`);
    expect(() => ctx.close()).not.toThrow();
  });

  it('should leave a finished context finished on close()', () => {
    const ctx = create();
    ctx.transform(input);
    ctx.finish();
    ctx.close();
    expect(() => ctx.transform(input)).toThrow(`${stream} already finished`);
    expect(() => ctx.finish()).toThrow(`${stream} already finished`);
  });

  it('should close at the end of a using declaration', () => {
    let disposed: Context | undefined;
    {
      using ctx = create();
      disposed = ctx;
    }
    expect(() => disposed?.finish()).toThrow(`${stream} already closed`);
  });
});

describe('browser Lz4DecompressContext.finish()', () => {
  const compressed = lz4Compress(data);
  const create = (): Context => {
    const Adapter = adapters.Lz4DecompressContext;
    if (!Adapter) throw new Error('browser/streaming.js has no Lz4DecompressContext');
    return new Adapter();
  };

  it('should decompress the buffered input and end the stream', () => {
    const ctx = create();
    ctx.transform(compressed);
    expect(Buffer.compare(ctx.finish(), data)).toBe(0);
    expect(() => ctx.finish()).toThrow('lz4 stream already finished');
  });

  it('should return nothing after flush()', () => {
    const ctx = create();
    ctx.transform(compressed);
    expect(Buffer.compare(ctx.flush(), data)).toBe(0);
    expect(ctx.finish().byteLength).toBe(0);
    expect(() => ctx.flush()).toThrow('lz4 stream already finished');
  });
});
