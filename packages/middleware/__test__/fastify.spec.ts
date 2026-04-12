import { request as httpRequest } from 'node:http';
import { brotliDecompress, gzipDecompress, zstdDecompress } from '@derodero24/comprs';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { comprs } from '../src/fastify.js';

const TEST_BODY = 'Hello, World! '.repeat(200);

function rawGet(
  baseUrl: string,
  path: string,
  acceptEncoding: string,
): Promise<{ status: number; headers: Record<string, string | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = httpRequest(url, { headers: { 'Accept-Encoding': acceptEncoding } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            'content-encoding': res.headers['content-encoding'],
            'content-type': res.headers['content-type'],
            'content-length': res.headers['content-length'],
            vary: res.headers.vary,
          },
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
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

    it('should remove Content-Length when compressing', async () => {
      const res = await rawGet(baseUrl, '/text', 'gzip');
      expect(res.headers['content-length']).toBeUndefined();
    });
  });
});
