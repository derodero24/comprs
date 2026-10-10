import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { brotliDecompressSync, constants, gunzipSync, inflateSync } from 'node:zlib';
import {
  BrotliCompressContext,
  brotliDecompress,
  DeflateCompressContext,
  GzipCompressContext,
  gzipDecompress,
  ZstdCompressContext,
  ZstdDecompressContext,
  zstdDecompress,
} from '@derodero24/comprs';
import { Hono } from 'hono';
import { stream, streamSSE, streamText } from 'hono/streaming';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Encoder } from '../src/compress.js';
import { comprs } from '../src/hono.js';
import type { Encoding } from '../src/types.js';

const TEST_BODY = 'Hello, World! '.repeat(200);
const TEXT = { 'Content-Type': 'text/plain' };
const ENCODINGS: readonly Encoding[] = ['zstd', 'br', 'gzip', 'deflate'];
const encoder = new TextEncoder();

/** The context class each encoding compresses with. */
const CONTEXTS: Record<Encoding, { prototype: Encoder }> = {
  zstd: ZstdCompressContext,
  br: BrotliCompressContext,
  gzip: GzipCompressContext,
  deflate: DeflateCompressContext,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function createApp(options?: Parameters<typeof comprs>[0]) {
  const app = new Hono();
  app.use(comprs(options));

  app.get('/text', (c) => c.text(TEST_BODY));
  app.get('/json', (c) => c.json({ message: TEST_BODY }));
  app.get('/small', (c) => c.text('tiny'));
  app.get('/image', (c) => {
    return c.body(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      headers: { 'Content-Type': 'image/png' },
    });
  });
  app.get('/no-transform', (c) => {
    c.header('Cache-Control', 'no-transform');
    return c.text(TEST_BODY);
  });

  return app;
}

async function rawGet(app: Hono, path: string, acceptEncoding: string) {
  const res = await app.request(path, {
    headers: { 'Accept-Encoding': acceptEncoding },
  });
  return {
    status: res.status,
    headers: {
      'content-encoding': res.headers.get('content-encoding') ?? undefined,
      'content-type': res.headers.get('content-type') ?? undefined,
      vary: res.headers.get('vary') ?? undefined,
    },
    body: Buffer.from(await res.arrayBuffer()),
  };
}

/** Settle like `promise`, or reject if it takes longer than `ms`. */
async function within<T>(promise: T | Promise<T>, ms = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no result within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function bodyReader(res: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (!res.body) throw new Error('expected a response body');
  return res.body.getReader();
}

/** Decode as much of a compressed stream as has been received. */
function decodeReceived(encoding: string | null, data: Buffer): string {
  switch (encoding) {
    case 'zstd':
      return new ZstdDecompressContext().transform(data).toString();
    case 'br':
      return brotliDecompressSync(data, {
        finishFlush: constants.BROTLI_OPERATION_FLUSH,
      }).toString();
    case 'gzip':
      return gunzipSync(data, { finishFlush: constants.Z_SYNC_FLUSH }).toString();
    case 'deflate':
      return inflateSync(data, { finishFlush: constants.Z_SYNC_FLUSH }).toString();
    default:
      return data.toString();
  }
}

/** Decode a complete compressed body. */
function decodeAll(encoding: string | null, data: Buffer): string {
  switch (encoding) {
    case 'zstd':
      return zstdDecompress(data).toString();
    case 'br':
      return brotliDecompress(data).toString();
    case 'gzip':
      return gzipDecompress(data).toString();
    case 'deflate':
      return inflateSync(data).toString();
    default:
      return data.toString();
  }
}

/**
 * Read a body until its decoded text contains `expected`, without waiting
 * for its end; returns the decoded text.
 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  encoding: string | null,
  expected: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`the body ended before ${JSON.stringify(expected)}`);
    chunks.push(value);
    const text = decodeReceived(encoding, Buffer.concat(chunks));
    if (text.includes(expected)) return text;
  }
}

describe('comprs hono middleware', () => {
  const app = createApp();

  describe('compression', () => {
    it('should compress with gzip', async () => {
      const res = await rawGet(app, '/text', 'gzip');
      expect(res.headers['content-encoding']).toBe('gzip');
      const decompressed = gzipDecompress(res.body);
      expect(decompressed.toString()).toBe(TEST_BODY);
    });

    it('should compress with brotli', async () => {
      const res = await rawGet(app, '/text', 'br');
      expect(res.headers['content-encoding']).toBe('br');
      const decompressed = brotliDecompress(res.body);
      expect(decompressed.toString()).toBe(TEST_BODY);
    });

    it('should compress with zstd', async () => {
      const res = await rawGet(app, '/text', 'zstd');
      expect(res.headers['content-encoding']).toBe('zstd');
      const decompressed = zstdDecompress(res.body);
      expect(decompressed.toString()).toBe(TEST_BODY);
    });

    it('should prefer zstd based on server preference', async () => {
      const res = await rawGet(app, '/text', 'gzip, zstd, br');
      expect(res.headers['content-encoding']).toBe('zstd');
    });

    it('should compress JSON responses', async () => {
      const res = await rawGet(app, '/json', 'gzip');
      expect(res.headers['content-encoding']).toBe('gzip');
      const decompressed = gzipDecompress(res.body);
      const parsed = JSON.parse(decompressed.toString());
      expect(parsed.message).toBe(TEST_BODY);
    });
  });

  describe('skip conditions', () => {
    it('should not compress small responses', async () => {
      const res = await rawGet(app, '/small', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
    });

    it('should not compress non-compressible types', async () => {
      const res = await rawGet(app, '/image', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
    });

    it('should not compress when no-transform', async () => {
      const res = await rawGet(app, '/no-transform', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
    });

    it('should not compress when client rejects all', async () => {
      const res = await rawGet(app, '/text', 'identity');
      expect(res.headers['content-encoding']).toBeUndefined();
    });
  });

  describe('headers', () => {
    it('should set Vary: Accept-Encoding', async () => {
      const res = await rawGet(app, '/text', 'gzip');
      expect(res.headers.vary).toContain('Accept-Encoding');
    });

    it('should set Vary even when not compressing', async () => {
      const res = await rawGet(app, '/small', 'gzip');
      expect(res.headers.vary).toContain('Accept-Encoding');
    });

    // Up to Hono 4.7.6, setting a header after next() changed the response
    // in place, which throws for the immutable headers of fetch().
    it('should compress a response from fetch(), whose headers are immutable', async () => {
      const message = { message: TEST_BODY };
      const upstream = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(message));
      });
      upstream.listen(0, '127.0.0.1');
      await once(upstream, 'listening');
      try {
        const address = upstream.address();
        if (address === null || typeof address === 'string') {
          throw new Error('expected a TCP address');
        }
        const app = new Hono();
        app.use(comprs());
        app.get('/', () => fetch(`http://127.0.0.1:${address.port}/`));

        const res = await within(app.request('/', { headers: { 'Accept-Encoding': 'gzip' } }));
        expect(res.status).toBe(200);
        expect(res.headers.get('vary')).toBe('Accept-Encoding');
        expect(res.headers.get('content-encoding')).toBe('gzip');
        const body = gzipDecompress(Buffer.from(await within(res.arrayBuffer())));
        expect(JSON.parse(body.toString())).toEqual(message);
      } finally {
        upstream.closeAllConnections();
        upstream.close();
      }
    });
  });

  describe('streaming', () => {
    it.each(ENCODINGS)(
      'sends what a stream that stays open has produced (%s)',
      async (encoding) => {
        const close = vi.spyOn(CONTEXTS[encoding].prototype, 'close');
        let cancelled = false;
        const app = new Hono();
        app.use(comprs());
        app.get(
          '/',
          () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(encoder.encode(TEST_BODY));
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: TEXT },
            ),
        );

        const res = await within(app.request('/', { headers: { 'Accept-Encoding': encoding } }));
        expect(res.headers.get('content-encoding')).toBe(encoding);
        const reader = bodyReader(res);
        expect(await within(readUntil(reader, encoding, TEST_BODY))).toBe(TEST_BODY);
        // Cancelling the compressed stream releases the handler's stream and
        // the encoder.
        await reader.cancel();
        expect(cancelled).toBe(true);
        expect(close).toHaveBeenCalledOnce();
      },
    );

    it('sends each write of an endless streamText() as it happens', async () => {
      const app = new Hono();
      app.use(comprs());
      app.get('/', (c) =>
        streamText(c, async (s) => {
          for (let i = 0; !s.aborted; i++) {
            await s.write(`tick ${i}\n`);
            await s.sleep(10);
          }
        }),
      );

      const res = await within(app.request('/', { headers: { 'Accept-Encoding': 'gzip' } }));
      expect(res.headers.get('content-encoding')).toBe('gzip');
      const reader = bodyReader(res);
      // Ticks are written 10 ms apart, so they arrive in separate flushes.
      const text = await within(readUntil(reader, 'gzip', 'tick 2\n'));
      expect(text).toBe('tick 0\ntick 1\ntick 2\n');
      await reader.cancel();
    });

    it('sends the events of an endless streamSSE() as they happen', async () => {
      const app = new Hono();
      app.use(comprs());
      app.get('/', (c) =>
        streamSSE(c, async (s) => {
          for (let i = 0; !s.aborted; i++) {
            await s.writeSSE({ data: `event ${i} ${'hello '.repeat(300)}` });
            await s.sleep(10);
          }
        }),
      );

      const res = await within(app.request('/', { headers: { 'Accept-Encoding': 'gzip' } }));
      // Server-Sent Events are not compressed, so that none is held back.
      expect(res.headers.get('content-encoding')).toBeNull();
      const reader = bodyReader(res);
      await within(readUntil(reader, null, 'data: event 1 '));
      await reader.cancel();
    });

    it('reads the body only as fast as the compressed stream is read', async () => {
      const chunks: string[] = [];
      const app = new Hono();
      app.use(comprs());
      app.get(
        '/',
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                const chunk = randomBytes(12 * 1024).toString('base64');
                chunks.push(chunk);
                controller.enqueue(encoder.encode(chunk));
                if (chunks.length === 1000) controller.close();
              },
            }),
            { headers: TEXT },
          ),
      );

      const res = await within(app.request('/', { headers: { 'Accept-Encoding': 'gzip' } }));
      const [first] = chunks;
      if (first === undefined) throw new Error('expected the body to be read');
      const reader = bodyReader(res);
      await within(readUntil(reader, 'gzip', first));
      const pulled = chunks.length;
      // Of the 1000 chunks of 16 KiB, about 1 MiB was read ahead, and no
      // more is read while nothing reads the response.
      expect(pulled).toBeLessThan(100);
      await sleep(50);
      expect(chunks).toHaveLength(pulled);
      await reader.cancel();
    });

    it.each(ENCODINGS)('compresses a stream that ends later (%s)', async (encoding) => {
      const parts = ['first ', 'second ', 'third'].map((part) => part.repeat(200));
      const app = new Hono();
      app.use(comprs());
      app.get('/', (c) => {
        c.header('Content-Type', 'text/plain');
        return stream(c, async (s) => {
          for (const part of parts) {
            await s.write(part);
            await s.sleep(5);
          }
        });
      });

      const res = await within(app.request('/', { headers: { 'Accept-Encoding': encoding } }));
      expect(res.headers.get('content-encoding')).toBe(encoding);
      expect(decodeAll(encoding, Buffer.from(await within(res.arrayBuffer())))).toBe(
        parts.join(''),
      );
    });

    it('compresses a stream that ends at once in one piece', async () => {
      const app = new Hono();
      app.use(comprs());
      app.get('/', (c) =>
        streamText(c, async (s) => {
          await s.write(TEST_BODY);
        }),
      );

      const res = await within(app.request('/', { headers: { 'Accept-Encoding': 'gzip' } }));
      expect(res.headers.get('content-encoding')).toBe('gzip');
      // The compressed body has a known length, which the server sends
      // instead of the chunked encoding that streamText() asked for.
      expect(res.headers.get('transfer-encoding')).toBeNull();
      expect(gzipDecompress(Buffer.from(await res.arrayBuffer())).toString()).toBe(TEST_BODY);
    });

    it('leaves a stream that ends at once below the threshold uncompressed', async () => {
      const app = new Hono();
      app.use(comprs());
      app.get('/', (c) =>
        streamText(c, async (s) => {
          await s.write('tiny');
        }),
      );

      const res = await within(app.request('/', { headers: { 'Accept-Encoding': 'gzip' } }));
      expect(res.headers.get('content-encoding')).toBeNull();
      expect(res.headers.get('vary')).toBe('Accept-Encoding');
      expect(await res.text()).toBe('tiny');
    });
  });

  describe('errors', () => {
    it('aborts the compressed body when the stream fails later', async () => {
      const close = vi.spyOn(GzipCompressContext.prototype, 'close');
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      const app = new Hono();
      app.use(comprs());
      app.get(
        '/',
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                source = controller;
                controller.enqueue(encoder.encode(TEST_BODY));
              },
            }),
            { headers: TEXT },
          ),
      );

      const res = await within(app.request('/', { headers: { 'Accept-Encoding': 'gzip' } }));
      expect(res.headers.get('content-encoding')).toBe('gzip');
      // The stream fails once the compressed response has been returned.
      source?.error(new Error('stream failed'));
      await expect(within(res.arrayBuffer())).rejects.toThrow('stream failed');
      expect(close).toHaveBeenCalledOnce();
    });

    it('passes a stream that fails at once to the error handler', async () => {
      const errors: Error[] = [];
      const app = new Hono();
      app.use(comprs());
      app.onError((err, c) => {
        errors.push(err);
        return c.text('handled', 500);
      });
      app.get(
        '/',
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error('stream failed'));
              },
            }),
            { headers: TEXT },
          ),
      );

      const res = await within(app.request('/', { headers: { 'Accept-Encoding': 'gzip' } }));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('handled');
      expect(errors.map((err) => err.message)).toEqual(['stream failed']);
    });
  });
});
