import { brotliCompress, deflateCompress, gzipCompress, zstdCompress } from '@derodero24/comprs';
import type { Context, MiddlewareHandler } from 'hono';

import { negotiate } from './negotiate.js';
import { appendVary, DEFAULT_ENCODINGS, DEFAULT_THRESHOLD, isCompressibleType } from './shared.js';
import type { Encoding, LevelOptions } from './types.js';

/** Hono-specific options (filter receives Hono Context). */
export interface HonoComprsOptions {
  encodings?: Encoding[];
  threshold?: number;
  level?: LevelOptions;
  filter?: (c: Context) => boolean;
}

function compressBuffer(encoding: Encoding, data: Uint8Array, level?: LevelOptions): Buffer {
  switch (encoding) {
    case 'zstd':
      return zstdCompress(data, level?.zstd);
    case 'br':
      return brotliCompress(data, level?.br);
    case 'gzip':
      return gzipCompress(data, level?.gzip);
    case 'deflate':
      return deflateCompress(data, level?.deflate);
  }
}

function shouldSkip(c: Context, filter?: (c: Context) => boolean): boolean {
  if (c.res.headers.has('content-encoding')) return true;
  const cacheControl = c.res.headers.get('cache-control');
  if (cacheControl?.includes('no-transform')) return true;
  if (filter && !filter(c)) return true;
  if (!isCompressibleType(c.res.headers.get('content-type') ?? undefined)) return true;
  return false;
}

/**
 * Hono compression middleware.
 *
 * Uses synchronous compression since Hono processes the response body at once
 * via the Web Standards Response API.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono';
 * import { comprs } from '@derodero24/comprs-middleware/hono';
 *
 * const app = new Hono();
 * app.use(comprs({ encodings: ['zstd', 'br', 'gzip'] }));
 * ```
 */
export function comprs(options: HonoComprsOptions = {}): MiddlewareHandler {
  const {
    encodings = [...DEFAULT_ENCODINGS] as Encoding[],
    threshold = DEFAULT_THRESHOLD,
    level,
    filter,
  } = options;

  return async (c, next) => {
    await next();

    if (c.req.method === 'HEAD') return;

    const encoding = negotiate(c.req.header('accept-encoding'), encodings);

    // Always set Vary
    c.header('Vary', appendVary(c.res.headers.get('vary') ?? undefined));

    if (!encoding) return;
    if (shouldSkip(c, filter)) return;

    // Early threshold check via Content-Length to avoid reading the body
    const contentLength = c.res.headers.get('content-length');
    if (contentLength) {
      const len = Number.parseInt(contentLength, 10);
      if (Number.isFinite(len) && len < threshold) return;
    }

    // Clone before reading body so we can fall back to original if below threshold
    const cloned = c.res.clone();
    const body = await cloned.arrayBuffer();
    const data = new Uint8Array(body);

    if (data.length < threshold) return;

    const compressed = compressBuffer(encoding, data, level);

    const headers = new Headers(c.res.headers);
    headers.set('Content-Encoding', encoding);
    headers.delete('Content-Length');

    c.res = new Response(compressed, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  };
}
