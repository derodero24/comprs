import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';

import { comprs } from '../src/hono.js';

// A failure that the native compressor can only produce in rare conditions,
// such as running out of memory.
vi.mock('@derodero24/comprs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@derodero24/comprs')>();
  return {
    ...actual,
    gzipCompressAsync: () => Promise.reject(new Error('allocation failed')),
  };
});

const BODY = 'Hello, World! '.repeat(200);

it('passes a compression failure to the error handler', async () => {
  const errors: Error[] = [];
  const app = new Hono();
  app.use(comprs());
  app.onError((err, c) => {
    errors.push(err);
    return c.text('handled', 500);
  });
  app.get('/', (c) => c.text(BODY));

  const res = await app.request('/', { headers: { 'Accept-Encoding': 'gzip' } });
  expect(res.status).toBe(500);
  expect(await res.text()).toBe('handled');
  expect(errors.map((err) => err.message)).toEqual(['allocation failed']);
});
