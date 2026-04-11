import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliDecompress, gzipDecompress, zstdDecompress } from '@derodero24/comprs';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { comprs } from '../src/middleware.js';

const TEST_BODY = 'Hello, World! '.repeat(200); // ~2.8 KB, above default threshold

function createApp(options?: Parameters<typeof comprs>[0]) {
  const app = express();
  app.use(comprs(options));
  app.get('/text', (_req, res) => {
    res.type('text/plain').send(TEST_BODY);
  });
  app.get('/json', (_req, res) => {
    res.json({ message: TEST_BODY });
  });
  app.get('/small', (_req, res) => {
    res.type('text/plain').send('tiny');
  });
  app.get('/image', (_req, res) => {
    res.type('image/png').send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  app.get('/no-transform', (_req, res) => {
    res.setHeader('Cache-Control', 'no-transform');
    res.type('text/plain').send(TEST_BODY);
  });
  app.get('/pre-encoded', (_req, res) => {
    res.setHeader('Content-Encoding', 'identity');
    res.type('text/plain').send(TEST_BODY);
  });
  return app;
}

/**
 * Raw HTTP request that does NOT auto-decompress Content-Encoding.
 * Node.js fetch auto-decompresses, which makes testing compression impossible.
 */
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
            'cache-control': res.headers['cache-control'],
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

let baseUrl: string;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('comprs middleware', () => {
  describe('compression', () => {
    it('should compress with gzip when requested', async () => {
      const res = await rawGet(baseUrl, '/text', 'gzip');
      expect(res.headers['content-encoding']).toBe('gzip');
      const decompressed = gzipDecompress(res.body);
      expect(decompressed.toString()).toBe(TEST_BODY);
    });

    it('should compress with brotli when requested', async () => {
      const res = await rawGet(baseUrl, '/text', 'br');
      expect(res.headers['content-encoding']).toBe('br');
      const decompressed = brotliDecompress(res.body);
      expect(decompressed.toString()).toBe(TEST_BODY);
    });

    it('should compress with zstd when requested', async () => {
      const res = await rawGet(baseUrl, '/text', 'zstd');
      expect(res.headers['content-encoding']).toBe('zstd');
      const decompressed = zstdDecompress(res.body);
      expect(decompressed.toString()).toBe(TEST_BODY);
    });

    it('should prefer zstd over gzip based on server preference', async () => {
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

    it('should produce smaller output than original', async () => {
      const res = await rawGet(baseUrl, '/text', 'gzip');
      expect(res.body.length).toBeLessThan(Buffer.from(TEST_BODY).length);
    });
  });

  describe('skip conditions', () => {
    it('should not compress small responses below threshold', async () => {
      const res = await rawGet(baseUrl, '/small', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body.toString()).toBe('tiny');
    });

    it('should not compress non-compressible content types', async () => {
      const res = await rawGet(baseUrl, '/image', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
    });

    it('should not compress when Cache-Control: no-transform', async () => {
      const res = await rawGet(baseUrl, '/no-transform', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
    });

    it('should not compress when Content-Encoding already set', async () => {
      const res = await rawGet(baseUrl, '/pre-encoded', 'gzip');
      expect(res.headers['content-encoding']).toBe('identity');
    });

    it('should not compress when client does not accept any encoding', async () => {
      const res = await rawGet(baseUrl, '/text', 'identity');
      expect(res.headers['content-encoding']).toBeUndefined();
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

    it('should set Vary even when not compressing', async () => {
      const res = await rawGet(baseUrl, '/small', 'gzip');
      expect(res.headers.vary).toContain('Accept-Encoding');
    });
  });
});

describe('comprs middleware with custom options', () => {
  let customBaseUrl: string;
  let customServer: ReturnType<typeof createServer>;

  beforeAll(async () => {
    const app = createApp({
      encodings: ['br', 'gzip'],
      threshold: 100,
      filter: (_req, res) => {
        const ct = res.getHeader('content-type') as string | undefined;
        return ct?.includes('text/plain') ?? false;
      },
    });
    customServer = createServer(app);
    await new Promise<void>((resolve) => {
      customServer.listen(0, () => resolve());
    });
    const { port } = customServer.address() as AddressInfo;
    customBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      customServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('should respect custom encoding preference', async () => {
    const res = await rawGet(customBaseUrl, '/text', 'gzip, br, zstd');
    // br is preferred over gzip in custom config, zstd not included
    expect(res.headers['content-encoding']).toBe('br');
  });

  it('should not compress with excluded encoding', async () => {
    const res = await rawGet(customBaseUrl, '/text', 'zstd');
    // zstd not in custom encodings
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('should use custom filter to skip JSON', async () => {
    const res = await rawGet(customBaseUrl, '/json', 'gzip');
    // Custom filter only allows text/plain
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
