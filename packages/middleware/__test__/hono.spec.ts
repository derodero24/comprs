import { brotliDecompress, gzipDecompress, zstdDecompress } from '@derodero24/comprs';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { comprs } from '../src/hono.js';

const TEST_BODY = 'Hello, World! '.repeat(200);

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
  });
});
