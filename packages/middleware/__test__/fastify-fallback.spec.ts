import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { comprs } from '../src/fastify.js';

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

it('sends the reply uncompressed when compression fails', async () => {
  const lines: string[] = [];
  const stream = { write: (line: string) => lines.push(line) };
  const app = Fastify({ logger: { level: 'warn', stream } });
  await app.register(comprs);
  app.get('/', (_request, reply) => {
    reply.type('text/plain').send(BODY);
  });

  const res = await app.inject({ url: '/', headers: { 'accept-encoding': 'gzip' } });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-encoding']).toBeUndefined();
  expect(res.headers['content-length']).toBe(String(BODY.length));
  expect(res.headers.vary).toBe('Accept-Encoding');
  expect(res.body).toBe(BODY);
  expect(lines.join('')).toContain('allocation failed');
  await app.close();
});
