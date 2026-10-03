import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  request,
  type Server,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, type Transform, type TransformCallback } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipDecompress } from '@derodero24/comprs';
import express, { type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { comprs } from '../src/express.js';
import type { ComprsOptions } from '../src/types.js';

const BODY = 'Hello, World! '.repeat(200); // ~2.8 KB, above the default threshold

/** Compressors created by the middleware, plus switches for how the next ones behave. */
const compressors = vi.hoisted(() => {
  const created: Transform[] = [];
  return { created, failAfterFirstChunk: false, deferChunks: false };
});

vi.mock('../src/compress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/compress.js')>();
  return {
    createCompressTransform: (
      ...args: Parameters<typeof actual.createCompressTransform>
    ): Transform => {
      const stream = actual.createCompressTransform(...args);
      compressors.created.push(stream);
      if (compressors.failAfterFirstChunk) {
        const transform = stream._transform.bind(stream);
        let chunks = 0;
        stream._transform = (
          chunk: Buffer,
          encoding: BufferEncoding,
          callback: TransformCallback,
        ) => {
          chunks += 1;
          if (chunks === 1) transform(chunk, encoding, callback);
          else callback(new Error('injected compressor failure'));
        };
      }
      if (compressors.deferChunks) {
        // Compress each chunk later, like a compressor that falls behind.
        const transform = stream._transform.bind(stream);
        stream._transform = (
          chunk: Buffer,
          encoding: BufferEncoding,
          callback: TransformCallback,
        ) => {
          setImmediate(() => transform(chunk, encoding, callback));
        };
      }
      return stream;
    },
  };
});

type Handler = (req: Request, res: Response) => void | Promise<void>;

interface RawResponse {
  status: number;
  statusMessage: string | undefined;
  headers: IncomingHttpHeaders;
  /** Body as received, still content-encoded. */
  body: Buffer;
  /** Whether the whole message arrived before the connection closed. */
  complete: boolean;
}

const servers: Server[] = [];

afterEach(async () => {
  compressors.created.length = 0;
  compressors.failAfterFirstChunk = false;
  compressors.deferChunks = false;
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }),
  );
});

/** Serve `handler` at `/` behind the middleware; returns options that reach it. */
async function serve(
  handler: Handler,
  options?: ComprsOptions,
  socketPath?: string,
): Promise<RequestOptions> {
  const app = express();
  app.use(comprs(options));
  app.get('/', handler);
  const server = createServer(app);
  servers.push(server);
  if (socketPath) {
    server.listen(socketPath);
    await once(server, 'listening');
    return { socketPath };
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return { host: '127.0.0.1', port: address.port };
}

/** Send a gzip-accepting GET request; resolves before the body is read. */
function open(target: RequestOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ ...target, headers: { 'Accept-Encoding': 'gzip' } }, resolve);
    req.on('error', reject);
    req.end();
  });
}

/** Send a gzip-accepting GET request and collect the raw response, even if aborted. */
async function get(target: RequestOptions): Promise<RawResponse> {
  const res = await open(target);
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  // An aborted body is reported through `complete` instead of an error.
  res.on('error', () => {});
  await new Promise((resolve) => res.on('close', resolve));
  return {
    status: res.statusCode ?? 0,
    statusMessage: res.statusMessage,
    headers: res.headers,
    body: Buffer.concat(chunks),
    complete: res.complete,
  };
}

/** Decode a response body according to its Content-Encoding. */
function decode(res: RawResponse): string {
  return res.headers['content-encoding'] === 'gzip'
    ? gzipDecompress(res.body).toString()
    : res.body.toString();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Wait until `value()` has stopped changing for a while. */
async function settle(value: () => number): Promise<void> {
  let last = Number.NaN;
  for (let stable = 0; stable < 10; ) {
    await sleep(20);
    const current = value();
    stable = current === last ? stable + 1 : 0;
    last = current;
  }
}

describe('express adapter: deciding when the headers are emitted', () => {
  it('compresses after writeHead() with a headers object', async () => {
    const target = await serve((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(BODY),
      });
      res.end(BODY);
    });
    const res = await get(target);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(decode(res)).toBe(BODY);
  });

  it('compresses after writeHead() with a status message, then write()', async () => {
    const target = await serve((_req, res) => {
      res.writeHead(201, 'Made', { 'Content-Type': 'text/plain' });
      res.write(BODY);
      res.end();
    });
    const res = await get(target);
    expect(res.status).toBe(201);
    expect(res.statusMessage).toBe('Made');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(decode(res)).toBe(BODY);
  });

  it('compresses after writeHead() with a flat header array', async () => {
    const target = await serve((_req, res) => {
      res.writeHead(200, ['Content-Type', 'text/plain', 'X-Test', 'yes']);
      res.end(BODY);
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['x-test']).toBe('yes');
    expect(decode(res)).toBe(BODY);
  });

  it('compresses after flushHeaders()', async () => {
    const target = await serve((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.flushHeaders();
      res.write(BODY);
      res.end();
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(decode(res)).toBe(BODY);
  });

  it('honors writeHead() headers that rule compression out', async () => {
    const target = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(BODY);
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString()).toBe(BODY);
  });

  it('keeps the Content-Length of an uncompressed end(body)', async () => {
    const target = await serve((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end('tiny');
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['content-length']).toBe('4');
    expect(res.body.toString()).toBe('tiny');
  });

  it('does not compress a status without a body sent with writeHead()', async () => {
    const target = await serve((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(304);
      res.end();
    });
    const res = await get(target);
    expect(res.status).toBe(304);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers.vary).toBe('Accept-Encoding');
  });

  it('does not compress a response ended without a body', async () => {
    const target = await serve((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end();
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['content-length']).toBe('0');
    expect(res.body).toHaveLength(0);
  });

  it('adds no Content-Length to a HEAD response ended without a body', async () => {
    const target = await serve((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end();
    });
    // Content-Length: 0 would claim that the GET response is empty.
    const res = await get({ ...target, method: 'HEAD' });
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(res.headers['content-length']).toBeUndefined();
  });

  it('lets the error handler respond when writeHead() rejects its status code', async () => {
    const target = await serve((_req, res) => {
      res.type('text/plain');
      res.writeHead(1000);
    });
    const res = await get(target);
    expect(res.status).toBe(500);
    expect(res.complete).toBe(true);
    expect(decode(res)).toContain('<!DOCTYPE html>');
  });

  it('restores the headers it changed when writeHead() rejects its status code', async () => {
    const length = String(Buffer.byteLength(BODY));
    const target = await serve((_req, res) => {
      res.type('text/plain');
      res.setHeader('ETag', '"v1"');
      res.setHeader('Content-Length', length);
      try {
        res.writeHead(1000);
      } catch {
        // Send the body uncompressed instead, with the headers set before.
        res.setHeader('Cache-Control', 'no-transform');
        res.end(BODY);
      }
    });
    const res = await get(target);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers.etag).toBe('"v1"');
    expect(res.headers['content-length']).toBe(length);
    expect(res.body.toString()).toBe(BODY);
  });

  it('does not compress a range sent with writeHead()', async () => {
    const target = await serve((_req, res) => {
      res.writeHead(206, {
        'Content-Type': 'text/plain',
        'Content-Range': `bytes 0-${BODY.length - 1}/${BODY.length * 2}`,
      });
      res.end(BODY);
    });
    const res = await get(target);
    expect(res.status).toBe(206);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(res.body.toString()).toBe(BODY);
  });
});

describe('express adapter: array-valued headers', () => {
  it('honors no-transform in an array-valued Cache-Control', async () => {
    const target = await serve((_req, res) => {
      res.setHeader('Cache-Control', ['public', 'no-transform']);
      res.type('text/plain').send(BODY);
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString()).toBe(BODY);
  });

  it('keeps an array-valued Vary when adding Accept-Encoding', async () => {
    const target = await serve((_req, res) => {
      res.setHeader('Vary', ['Origin', 'Cookie']);
      res.type('text/plain').send(BODY);
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers.vary).toBe('Origin, Cookie, Accept-Encoding');
  });
});

describe('express adapter: ServerResponse semantics', () => {
  const cases = [
    { label: 'compressed', body: BODY, encoding: 'gzip' },
    { label: 'below the threshold', body: 'tiny', encoding: undefined },
  ];

  it.each(cases)('fails write() after end() like ServerResponse ($label)', async (testCase) => {
    const outcome = deferred<{ returned: boolean; callbackError: unknown; eventError: unknown }>();
    const target = await serve((_req, res) => {
      res.type('text/plain');
      res.end(testCase.body);
      let callbackError: unknown;
      const returned = res.write('more', (err) => {
        callbackError = err;
      });
      res.on('error', (eventError) => outcome.resolve({ returned, callbackError, eventError }));
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBe(testCase.encoding);
    expect(decode(res)).toBe(testCase.body);
    const { returned, callbackError, eventError } = await outcome.promise;
    expect(returned).toBe(false);
    expect(callbackError).toMatchObject({ code: 'ERR_STREAM_WRITE_AFTER_END' });
    expect(eventError).toBe(callbackError);
  });

  it.each(cases)('fails end(chunk) after end() like ServerResponse ($label)', async (testCase) => {
    const outcome = deferred<{ callbackError: unknown; eventError: unknown }>();
    const target = await serve((_req, res) => {
      res.type('text/plain');
      res.end(testCase.body);
      let callbackError: unknown;
      res.end('more', (...args: unknown[]) => {
        callbackError = args[0];
      });
      res.on('error', (eventError) => outcome.resolve({ callbackError, eventError }));
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBe(testCase.encoding);
    expect(decode(res)).toBe(testCase.body);
    const { callbackError, eventError } = await outcome.promise;
    expect(callbackError).toMatchObject({ code: 'ERR_STREAM_WRITE_AFTER_END' });
    expect(eventError).toBe(callbackError);
  });

  it.each(cases)(
    'runs the end() callback once the response finished ($label)',
    async (testCase) => {
      const finished = deferred<boolean>();
      const target = await serve((_req, res) => {
        res.type('text/plain');
        res.end(testCase.body, () => finished.resolve(res.writableFinished));
      });
      const res = await get(target);
      expect(res.headers['content-encoding']).toBe(testCase.encoding);
      // Node 22 runs the callback after the 'finish' listeners and Node 24
      // before them, so check that the response had finished, not the order.
      expect(await finished.promise).toBe(true);
    },
  );

  it('holds a repeated end() callback until the compressed response finished', async () => {
    const order = deferred<string[]>();
    const target = await serve((_req, res) => {
      const events: string[] = [];
      res.type('text/plain');
      res.on('finish', () => events.push('finish'));
      res.on('close', () => order.resolve(events));
      res.end(BODY);
      res.end(() => events.push('second end callback'));
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(await order.promise).toEqual(['finish', 'second end callback']);
  });

  it("emits 'drain' once a compressor that fell behind has caught up", async () => {
    compressors.deferChunks = true;
    const chunk = BODY.repeat(32); // ~90 KB, above the compressor's highWaterMark
    const waits = deferred<number>();
    const target = await serve(async (_req, res) => {
      res.type('text/plain');
      let count = 0;
      for (let i = 0; i < 8; i++) {
        if (!res.write(chunk)) {
          count += 1;
          await once(res, 'drain');
        }
      }
      res.end();
      waits.resolve(count);
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(decode(res)).toBe(chunk.repeat(8));
    expect(await waits.promise).toBe(8);
  });

  it('keeps a res.emit() wrapper installed after the middleware', async () => {
    const seen = deferred<string[]>();
    const target = await serve((_req, res) => {
      const events: string[] = [];
      const emit = res.emit.bind(res);
      res.emit = (event: string | symbol, ...args: unknown[]): boolean => {
        if (typeof event === 'string') events.push(event);
        return emit(event, ...args);
      };
      res.on('close', () => seen.resolve(events));
      res.type('text/plain').send(BODY);
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(await seen.promise).toContain('finish');
  });
});

// Unix sockets keep the kernel buffers small (a few hundred KiB), so a few MiB
// of body tell a response that holds back from one that buffers everything.
describe.skipIf(process.platform === 'win32')('express adapter: backpressure', () => {
  const chunkSize = 64 * 1024;
  const chunkCount = 64;
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'comprs-middleware-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Serve `handler` on a Unix socket; gzip level 0 keeps the output as large as the input. */
  function serveOnSocket(handler: Handler): Promise<RequestOptions> {
    return serve(handler, { level: { gzip: 0 } }, join(dir, 'server.sock'));
  }

  /** Read the rest of the response; returns the SHA-256 of its decompressed body. */
  async function bodyHash(res: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    await once(res, 'end');
    return createHash('sha256')
      .update(gzipDecompress(Buffer.concat(chunks)))
      .digest('hex');
  }

  it('stops reading a piped source while the client is not reading', async () => {
    const sent = createHash('sha256');
    let produced = 0;
    let peakBuffered = 0;
    const target = await serveOnSocket((_req, res) => {
      res.type('text/plain');
      new Readable({
        read() {
          peakBuffered = Math.max(peakBuffered, res.writableLength);
          if (produced === chunkCount) {
            this.push(null);
            return;
          }
          const chunk = randomBytes(chunkSize);
          sent.update(chunk);
          produced += 1;
          this.push(chunk);
        },
      }).pipe(res);
    });

    const res = await open(target);
    await settle(() => produced);
    expect(produced).toBeLessThan(chunkCount / 2);
    expect(peakBuffered).toBeLessThan(512 * 1024);
    expect(await bodyHash(res)).toBe(sent.digest('hex'));
  });

  it("returns false from write() while the client is not reading, then emits 'drain'", async () => {
    const sent = createHash('sha256');
    let written = 0;
    const target = await serveOnSocket(async (_req, res) => {
      res.type('text/plain');
      while (written < chunkCount) {
        const chunk = randomBytes(chunkSize);
        sent.update(chunk);
        written += 1;
        if (!res.write(chunk)) await once(res, 'drain');
      }
      res.end();
    });

    const res = await open(target);
    await settle(() => written);
    expect(written).toBeLessThan(chunkCount / 2);
    expect(await bodyHash(res)).toBe(sent.digest('hex'));
  });
});

describe('express adapter: failures and disconnects', () => {
  it('destroys the response when the compressor fails after the headers were sent', async () => {
    compressors.failAfterFirstChunk = true;
    const finished = deferred<boolean>();
    const target = await serve((_req, res) => {
      res.type('text/plain');
      res.on('close', () => finished.resolve(res.writableFinished));
      res.write(BODY);
      setImmediate(() => res.end(BODY));
    });
    const res = await get(target);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.complete).toBe(false);
    expect(await finished.promise).toBe(false);
  });

  it('destroys the compressor when the client disconnects', async () => {
    const closed = deferred<void>();
    const target = await serve((_req, res) => {
      res.type('text/plain');
      const timer = setInterval(() => res.write(randomBytes(8 * 1024).toString('hex')), 5);
      res.on('close', () => {
        clearInterval(timer);
        closed.resolve();
      });
      res.write(randomBytes(8 * 1024).toString('hex'));
    });
    const res = await open(target);
    res.destroy();
    await closed.promise;
    expect(compressors.created).toHaveLength(1);
    expect(compressors.created[0]?.destroyed).toBe(true);
  });
});
