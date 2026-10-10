import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import { inflateSync } from 'node:zlib';
import { brotliDecompress, gzipDecompress } from '@derodero24/comprs';
import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { comprs as expressComprs } from '../src/express.js';
import { comprs as fastifyComprs } from '../src/fastify.js';
import { comprs as honoComprs } from '../src/hono.js';
import type { ComprsOptions } from '../src/types.js';

// HTTP behaviour that every adapter shares (RFC 9110), checked against each.

const BODY = 'Hello, World! '.repeat(200); // ~2.8 KB, above the default threshold
const TEXT = { 'Content-Type': 'text/plain' };

/** What a route sends, whatever the framework. */
interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

interface Received {
  status: number;
  /** Header fields by lowercase name, list values joined. */
  headers: Record<string, string | undefined>;
  /** Body as received, still content-encoded. */
  body: Buffer;
}

interface RequestInit {
  method?: string;
  acceptEncoding?: string;
}

type Client = (path: string, init?: RequestInit) => Promise<Received>;

/** The options every adapter accepts (the filter's signature differs). */
type Options = Omit<ComprsOptions, 'filter'>;

interface Adapter {
  name: string;
  /** Create the middleware; rejects when it rejects the options. */
  setup(options: Options): Promise<unknown>;
  /** Serve each route at its path behind the middleware. */
  serve(routes: Record<string, Route>, options?: Options): Promise<Client>;
}

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Listen on a free port and return a client for it. */
async function listen(server: Server): Promise<Client> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return httpClient(address.port);
}

function flatten(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(', ') : value,
    ]),
  );
}

/** A client that does not decode the body, unlike fetch(). */
function httpClient(port: number): Client {
  return (path, init = {}) =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (init.acceptEncoding !== undefined) headers['Accept-Encoding'] = init.acceptEncoding;
      const method = init.method ?? 'GET';
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: flatten(res.headers),
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
}

const adapters: Adapter[] = [
  {
    name: 'express',
    setup: (options) => new Promise((resolve) => resolve(expressComprs(options))),
    serve(routes, options) {
      const app = express();
      app.use(expressComprs(options));
      for (const [path, route] of Object.entries(routes)) {
        app.get(path, (_req, res) => {
          res.statusCode = route.status ?? 200;
          for (const [name, value] of Object.entries(route.headers ?? {})) {
            res.setHeader(name, value);
          }
          res.end(route.body);
        });
      }
      return listen(createServer(app));
    },
  },
  {
    name: 'fastify',
    async setup(options) {
      const app = Fastify();
      cleanups.push(() => app.close());
      await app.register(fastifyComprs, options);
    },
    async serve(routes, options) {
      const app = Fastify();
      cleanups.push(() => app.close());
      await app.register(fastifyComprs, options ?? {});
      for (const [path, route] of Object.entries(routes)) {
        app.get(path, (_request, reply) => {
          reply
            .code(route.status ?? 200)
            .headers(route.headers ?? {})
            .send(route.body);
        });
      }
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a TCP address');
      }
      return httpClient(address.port);
    },
  },
  {
    name: 'hono',
    setup: (options) => new Promise((resolve) => resolve(honoComprs(options))),
    serve(routes, options) {
      const app = new Hono();
      app.use(honoComprs(options));
      for (const [path, route] of Object.entries(routes)) {
        app.get(
          path,
          () =>
            new Response(route.body ?? null, {
              status: route.status ?? 200,
              headers: route.headers ?? {},
            }),
        );
      }
      return Promise.resolve(async (path: string, init: RequestInit = {}) => {
        const headers = new Headers();
        if (init.acceptEncoding !== undefined) headers.set('Accept-Encoding', init.acceptEncoding);
        const res = await app.request(path, { method: init.method ?? 'GET', headers });
        const received: Record<string, string> = {};
        for (const [name, value] of res.headers) received[name] = value;
        return {
          status: res.status,
          headers: received,
          body: Buffer.from(await res.arrayBuffer()),
        };
      });
    },
  },
];

/** Decode a body according to its Content-Encoding. */
function decode(res: Received): string {
  switch (res.headers['content-encoding']) {
    case 'gzip':
      return gzipDecompress(res.body).toString();
    case 'br':
      return brotliDecompress(res.body).toString();
    case 'deflate':
      return inflateSync(res.body).toString();
    default:
      return res.body.toString();
  }
}

describe.each(adapters)('$name adapter: HTTP semantics', (adapter) => {
  describe('compressed responses', () => {
    it('send the zlib format (RFC 1950) for deflate', async () => {
      const get = await adapter.serve({ '/': { headers: TEXT, body: BODY } });
      const res = await get('/', { acceptEncoding: 'deflate' });
      expect(res.headers['content-encoding']).toBe('deflate');
      // zlib header: CM 8 (deflate) with a 32 KiB window, then FCHECK.
      expect(res.body[0]).toBe(0x78);
      expect(inflateSync(res.body).toString()).toBe(BODY);
    });

    it('drop the Content-Length of the uncompressed body', async () => {
      const length = String(Buffer.byteLength(BODY));
      const get = await adapter.serve({
        '/': { headers: { ...TEXT, 'Content-Length': length }, body: BODY },
      });
      const res = await get('/', { acceptEncoding: 'gzip' });
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['content-length']).not.toBe(length);
      expect(decode(res)).toBe(BODY);
    });
  });

  describe('Accept-Encoding', () => {
    it.each([
      { acceptEncoding: 'gzip;Q=0', expected: undefined },
      { acceptEncoding: 'GZIP;Q=0.5', expected: 'gzip' },
      { acceptEncoding: 'gzip;q=2', expected: undefined },
      { acceptEncoding: 'gzip;q=-1', expected: undefined },
      { acceptEncoding: 'gzip;q=0.0001', expected: undefined },
      { acceptEncoding: 'br;q=abc, gzip', expected: 'gzip' },
      { acceptEncoding: '*;q=0.5, zstd;q=0', expected: 'br' },
      { acceptEncoding: '*, br;q=0, zstd;q=0', expected: 'gzip' },
      { acceptEncoding: 'identity;q=1, *;q=0', expected: undefined },
    ])('selects $expected for $acceptEncoding', async ({ acceptEncoding, expected }) => {
      const get = await adapter.serve({ '/': { headers: TEXT, body: BODY } });
      const res = await get('/', { acceptEncoding });
      expect(res.headers['content-encoding']).toBe(expected);
      expect(decode(res)).toBe(BODY);
    });
  });

  describe('Vary', () => {
    const routes = {
      '/text': { headers: TEXT, body: BODY },
      '/small': { headers: TEXT, body: 'tiny' },
      '/image': { headers: { 'Content-Type': 'image/png' }, body: BODY },
      '/no-transform': { headers: { ...TEXT, 'Cache-Control': 'no-transform' }, body: BODY },
      '/sse': { headers: { 'Content-Type': 'text/event-stream' }, body: `data: ${BODY}\n\n` },
    };

    it.each([
      { label: 'compressed', path: '/text', init: { acceptEncoding: 'gzip' } },
      { label: 'requested without Accept-Encoding', path: '/text', init: {} },
      {
        label: 'requested with HEAD',
        path: '/text',
        init: { method: 'HEAD', acceptEncoding: 'gzip' },
      },
      { label: 'with no acceptable encoding', path: '/text', init: { acceptEncoding: 'identity' } },
      { label: 'below the threshold', path: '/small', init: { acceptEncoding: 'gzip' } },
    ])('is added to a compressible response $label', async ({ path, init }) => {
      const get = await adapter.serve(routes);
      const res = await get(path, init);
      expect(res.headers['vary']).toBe('Accept-Encoding');
    });

    it.each([
      { label: 'a type that is not compressible', path: '/image' },
      { label: 'Cache-Control: no-transform', path: '/no-transform' },
      { label: 'Server-Sent Events', path: '/sse' },
    ])('is not added to a response with $label', async ({ path }) => {
      const get = await adapter.serve(routes);
      const res = await get(path, { acceptEncoding: 'gzip' });
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['vary']).toBeUndefined();
    });
  });

  describe('responses that are not compressed', () => {
    const range = `bytes 0-${BODY.length - 1}/${BODY.length * 2}`;

    it.each([
      { label: '204 No Content', route: { status: 204, headers: TEXT } },
      { label: '304 Not Modified', route: { status: 304, headers: { ...TEXT, ETag: '"v1"' } } },
      {
        label: '206 Partial Content',
        route: { status: 206, headers: { ...TEXT, 'Content-Range': range }, body: BODY },
      },
      {
        label: 'a Content-Range',
        route: { headers: { ...TEXT, 'Content-Range': range }, body: BODY },
      },
      { label: 'an empty body', route: { headers: TEXT, body: '' } },
    ])('leaves $label uncompressed', async ({ route }) => {
      // A threshold of 0 leaves the rule under test as the only reason to skip.
      const get = await adapter.serve({ '/': route }, { threshold: 0 });
      const res = await get('/', { acceptEncoding: 'gzip' });
      expect(res.status).toBe(route.status ?? 200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body.toString()).toBe(
        route.status === 204 || route.status === 304 ? '' : route.body,
      );
    });

    it('leaves the response to a HEAD request uncompressed', async () => {
      const get = await adapter.serve({ '/': { headers: TEXT, body: BODY } });
      const res = await get('/', { method: 'HEAD', acceptEncoding: 'gzip' });
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body).toHaveLength(0);
    });
  });

  describe('ETag', () => {
    const routes = {
      '/strong': { headers: { ...TEXT, ETag: '"v1"' }, body: BODY },
      '/weak': { headers: { ...TEXT, ETag: 'W/"v1"' }, body: BODY },
    };

    it('weakens a strong ETag when compressing', async () => {
      const get = await adapter.serve(routes);
      const res = await get('/strong', { acceptEncoding: 'gzip' });
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['etag']).toBe('W/"v1"');
    });

    it('keeps a weak ETag when compressing', async () => {
      const get = await adapter.serve(routes);
      const res = await get('/weak', { acceptEncoding: 'gzip' });
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['etag']).toBe('W/"v1"');
    });

    it('keeps a strong ETag when not compressing', async () => {
      const get = await adapter.serve(routes);
      const res = await get('/strong', { acceptEncoding: 'identity' });
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['etag']).toBe('"v1"');
    });
  });

  describe('options', () => {
    it.each([
      { options: { level: { gzip: 99 } }, error: /level\.gzip must be an integer from 0 to 9/ },
      { options: { level: { deflate: -1 } }, error: /level\.deflate must be an integer/ },
      { options: { level: { br: 1.5 } }, error: /level\.br must be an integer from 0 to 11/ },
      {
        options: { level: { zstd: 20 } },
        error: /level\.zstd must be an integer .* to 19.*RFC 9659/,
      },
      { options: { threshold: Number.NaN }, error: /threshold must be a finite number/ },
      { options: { threshold: -1 }, error: /threshold must be a finite number/ },
      { options: { encodings: [] }, error: /encodings must not be empty/ },
    ])('rejects $options at setup', async ({ options, error }) => {
      await expect(adapter.setup(options)).rejects.toThrow(error);
    });

    it('accepts the highest zstd level that RFC 9659 allows', async () => {
      const get = await adapter.serve(
        { '/': { headers: TEXT, body: BODY } },
        { level: { zstd: 19 } },
      );
      const res = await get('/', { acceptEncoding: 'zstd' });
      expect(res.headers['content-encoding']).toBe('zstd');
    });
  });
});
