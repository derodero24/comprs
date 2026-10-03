import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { brotliDecompress, gzipDecompress, zstdDecompress } from '@derodero24/comprs';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { comprs, type FastifyComprsOptions } from '../src/fastify.js';

const TEST_BODY = 'Hello, World! '.repeat(200);
const PLUGIN_NAME = '@derodero24/comprs-middleware';

function rawGet(
  baseUrl: string,
  path: string,
  acceptEncoding: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = httpRequest(url, { headers: { 'Accept-Encoding': acceptEncoding } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** A Web stream that sends `text` in two chunks. */
function webStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const middle = Math.floor(bytes.length / 2);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, middle));
      controller.enqueue(bytes.subarray(middle));
      controller.close();
    },
  });
}

/** An app with the plugin registered with `options` and one text route at `/`. */
async function textApp(options: FastifyComprsOptions): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(comprs, options);
  app.get('/', async (_request, reply) => {
    reply.type('text/plain');
    return TEST_BODY;
  });
  return app;
}

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = Fastify();
  await app.register(comprs);

  app.get('/text', async (_request, reply) => {
    reply.type('text/plain');
    return TEST_BODY;
  });

  app.get('/json', async () => {
    return { message: TEST_BODY };
  });

  app.get('/small', async (_request, reply) => {
    reply.type('text/plain');
    return 'tiny';
  });

  app.get('/image', async (_request, reply) => {
    reply.type('image/png');
    return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  });

  app.get('/no-transform', async (_request, reply) => {
    reply.header('Cache-Control', 'no-transform');
    reply.type('text/plain');
    return TEST_BODY;
  });

  app.get('/no-transform-array', async (_request, reply) => {
    reply.header('Cache-Control', ['public', 'no-transform']);
    reply.type('text/plain');
    return TEST_BODY;
  });

  app.get('/vary-array', async (_request, reply) => {
    reply.header('Vary', ['Origin', 'Cookie']);
    reply.type('text/plain');
    return TEST_BODY;
  });

  app.get('/bytes', async (_request, reply) => {
    reply.type('text/plain');
    return new TextEncoder().encode(TEST_BODY);
  });

  app.get('/node-stream', async (_request, reply) => {
    reply.type('text/plain');
    return Readable.from([TEST_BODY.slice(0, 100), TEST_BODY.slice(100)]);
  });

  app.get('/small-node-stream', async (_request, reply) => {
    reply.type('text/plain').header('Content-Length', 4);
    return Readable.from(['tiny']);
  });

  app.get('/web-stream', async (_request, reply) => {
    reply.type('text/plain');
    return webStream(TEST_BODY);
  });

  app.get(
    '/response',
    async () =>
      new Response(webStream(TEST_BODY), {
        status: 201,
        headers: { 'Content-Type': 'text/plain', ETag: '"v1"', 'X-Custom': 'kept' },
      }),
  );

  app.get(
    '/response-image',
    async () =>
      new Response(TEST_BODY, { headers: { 'Content-Type': 'image/png', 'X-Custom': 'kept' } }),
  );

  app.get('/response-used', async () => {
    const response = new Response(TEST_BODY, { headers: { 'Content-Type': 'text/plain' } });
    await response.text();
    return response;
  });

  app.get('/opt-out', { config: { compress: false } }, async (_request, reply) => {
    reply.type('text/plain');
    return TEST_BODY;
  });

  app.register(async (child) => {
    child.get('/child', async (_request, reply) => {
      reply.type('text/plain');
      return TEST_BODY;
    });
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.addresses()[0];
  baseUrl = `http://127.0.0.1:${addr?.port}`;
});

afterAll(async () => {
  await app.close();
});

describe('comprs fastify plugin', () => {
  describe('compression', () => {
    it('should compress with gzip', async () => {
      const res = await rawGet(baseUrl, '/text', 'gzip');
      expect(res.headers['content-encoding']).toBe('gzip');
      const decompressed = gzipDecompress(res.body);
      expect(decompressed.toString()).toBe(TEST_BODY);
    });

    it('should compress with brotli', async () => {
      const res = await rawGet(baseUrl, '/text', 'br');
      expect(res.headers['content-encoding']).toBe('br');
      const decompressed = brotliDecompress(res.body);
      expect(decompressed.toString()).toBe(TEST_BODY);
    });

    it('should compress with zstd', async () => {
      const res = await rawGet(baseUrl, '/text', 'zstd');
      expect(res.headers['content-encoding']).toBe('zstd');
      const decompressed = zstdDecompress(res.body);
      expect(decompressed.toString()).toBe(TEST_BODY);
    });

    it('should prefer zstd based on server preference', async () => {
      const res = await rawGet(baseUrl, '/text', 'gzip, zstd, br');
      expect(res.headers['content-encoding']).toBe('zstd');
    });

    it('should compress JSON responses', async () => {
      const res = await rawGet(baseUrl, '/json', 'gzip');
      expect(res.headers['content-encoding']).toBe('gzip');
      const decompressed = gzipDecompress(res.body);
      const parsed = JSON.parse(decompressed.toString());
      expect(parsed.message).toBe(TEST_BODY);
    });
  });

  describe('skip conditions', () => {
    it('should not compress small responses', async () => {
      const res = await rawGet(baseUrl, '/small', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
    });

    it('should not compress non-compressible types', async () => {
      const res = await rawGet(baseUrl, '/image', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
    });

    it('should not compress when no-transform', async () => {
      const res = await rawGet(baseUrl, '/no-transform', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
    });

    it('should honor no-transform in an array-valued Cache-Control', async () => {
      const res = await rawGet(baseUrl, '/no-transform-array', 'gzip');
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body.toString()).toBe(TEST_BODY);
    });

    it('should not compress when client only accepts identity', async () => {
      const res = await rawGet(baseUrl, '/text', 'identity');
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body.toString()).toBe(TEST_BODY);
    });
  });

  describe('headers', () => {
    it('should set Vary: Accept-Encoding', async () => {
      const res = await rawGet(baseUrl, '/text', 'gzip');
      expect(res.headers.vary).toContain('Accept-Encoding');
    });

    it('should keep an array-valued Vary when adding Accept-Encoding', async () => {
      const res = await rawGet(baseUrl, '/vary-array', 'gzip');
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers.vary).toBe('Origin, Cookie, Accept-Encoding');
    });

    it('should send the Content-Length of the compressed body', async () => {
      const res = await rawGet(baseUrl, '/text', 'gzip');
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['content-length']).toBe(String(res.body.length));
      expect(res.headers['transfer-encoding']).toBeUndefined();
      expect(gzipDecompress(res.body).toString()).toBe(TEST_BODY);
    });
  });

  describe('payloads', () => {
    it('should compress a Uint8Array payload with a Content-Length', async () => {
      const res = await rawGet(baseUrl, '/bytes', 'gzip');
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['content-length']).toBe(String(res.body.length));
      expect(gzipDecompress(res.body).toString()).toBe(TEST_BODY);
    });

    it('should compress a Node.js stream payload', async () => {
      const res = await rawGet(baseUrl, '/node-stream', 'gzip');
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['content-length']).toBeUndefined();
      expect(gzipDecompress(res.body).toString()).toBe(TEST_BODY);
    });

    it('should apply the threshold to a stream with a declared Content-Length', async () => {
      const res = await rawGet(baseUrl, '/small-node-stream', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers.vary).toBe('Accept-Encoding');
      expect(res.body.toString()).toBe('tiny');
    });

    it('should compress a Web ReadableStream payload', async () => {
      const res = await rawGet(baseUrl, '/web-stream', 'gzip');
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers.vary).toBe('Accept-Encoding');
      expect(gzipDecompress(res.body).toString()).toBe(TEST_BODY);
    });

    it('should compress the body of a Response, keeping its status and headers', async () => {
      const res = await rawGet(baseUrl, '/response', 'br');
      expect(res.status).toBe(201);
      expect(res.headers['content-encoding']).toBe('br');
      expect(res.headers['content-type']).toBe('text/plain');
      expect(res.headers['x-custom']).toBe('kept');
      expect(res.headers.etag).toBe('W/"v1"');
      expect(res.headers.vary).toBe('Accept-Encoding');
      expect(brotliDecompress(res.body).toString()).toBe(TEST_BODY);
    });

    it('should send a Response of a type that is not compressible as it is', async () => {
      const res = await rawGet(baseUrl, '/response-image', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers.vary).toBeUndefined();
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-custom']).toBe('kept');
      expect(res.body.toString()).toBe(TEST_BODY);
    });

    it('should leave a Response whose body was read for Fastify to reject', async () => {
      const res = await rawGet(baseUrl, '/response-used', 'gzip');
      expect(res.status).toBe(500);
      expect(res.body.toString()).toContain('FST_ERR_REP_RESPONSE_BODY_CONSUMED');
    });
  });

  describe('routes', () => {
    it('should leave a route with config.compress set to false alone', async () => {
      const res = await rawGet(baseUrl, '/opt-out', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers.vary).toBeUndefined();
      expect(res.body.toString()).toBe(TEST_BODY);
    });

    it('should compress the routes of child contexts', async () => {
      const res = await rawGet(baseUrl, '/child', 'gzip');
      expect(res.headers['content-encoding']).toBe('gzip');
    });
  });
});

describe('comprs fastify plugin registration', () => {
  it('should register as a named plugin that others can depend on', async () => {
    const app = Fastify();
    await app.register(comprs);
    await app.register(fastifyPlugin(async () => {}, { dependencies: [PLUGIN_NAME] }));
    expect(app.hasPlugin(PLUGIN_NAME)).toBe(true);
    await app.close();
  });

  it('should reject a shouldCompress that is not a function', async () => {
    const app = Fastify();
    const register = app.register(comprs, {
      // @ts-expect-error: shouldCompress is a function
      shouldCompress: 'yes',
    });
    await expect(register).rejects.toThrow(/shouldCompress must be a function, got "yes"/);
    await app.close();
  });
});

describe('comprs fastify plugin filters', () => {
  it('should let shouldCompress see the headers set through the reply', async () => {
    const seen: unknown[] = [];
    const app = await textApp({
      shouldCompress: (_request, reply) => {
        seen.push(reply.getHeader('content-type'));
        return reply.getHeader('x-no-compression') === undefined;
      },
    });
    app.get('/skip', async (_request, reply) => {
      reply.type('text/plain').header('X-No-Compression', '1');
      return TEST_BODY;
    });

    const compressed = await app.inject({ url: '/', headers: { 'accept-encoding': 'gzip' } });
    expect(compressed.headers['content-encoding']).toBe('gzip');
    const skipped = await app.inject({ url: '/skip', headers: { 'accept-encoding': 'gzip' } });
    expect(skipped.headers['content-encoding']).toBeUndefined();
    expect(skipped.headers.vary).toBeUndefined();
    expect(seen).toEqual(['text/plain', 'text/plain']);
    await app.close();
  });

  it('should let shouldCompress see the headers of a Response payload', async () => {
    const seen: unknown[] = [];
    const app = Fastify();
    await app.register(comprs, {
      shouldCompress: (request, reply) => {
        seen.push([request.url, reply.statusCode, reply.getHeader('content-type')]);
        return true;
      },
    });
    app.get(
      '/',
      async () =>
        new Response(TEST_BODY, { status: 202, headers: { 'Content-Type': 'text/plain' } }),
    );

    const res = await app.inject({ url: '/', headers: { 'accept-encoding': 'zstd' } });
    expect(res.headers['content-encoding']).toBe('zstd');
    expect(zstdDecompress(res.rawPayload).toString()).toBe(TEST_BODY);
    expect(seen).toEqual([['/', 202, 'text/plain']]);
    await app.close();
  });

  it('should still pass request.raw and reply.raw to filter', async () => {
    const seen: unknown[] = [];
    const app = Fastify();
    await app.register(comprs, {
      filter: (req, res) => {
        seen.push(req, res);
        return false;
      },
    });
    const raw: unknown[] = [];
    app.get('/', async (request, reply) => {
      raw.push(request.raw, reply.raw);
      reply.type('text/plain');
      return TEST_BODY;
    });

    const res = await app.inject({ url: '/', headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(raw[0]);
    expect(seen[1]).toBe(raw[1]);
    await app.close();
  });

  it.each([
    { filter: true, shouldCompress: true, expected: 'gzip' },
    { filter: false, shouldCompress: true, expected: undefined },
    { filter: true, shouldCompress: false, expected: undefined },
  ])('should compress only when both filters pass: $filter and $shouldCompress', async (cases) => {
    const app = await textApp({
      filter: () => cases.filter,
      shouldCompress: () => cases.shouldCompress,
    });

    const res = await app.inject({ url: '/', headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers['content-encoding']).toBe(cases.expected);
    await app.close();
  });
});
