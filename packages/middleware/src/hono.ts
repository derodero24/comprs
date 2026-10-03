import { brotliCompress, deflateCompress, gzipCompress, zstdCompress } from '@derodero24/comprs';
import type { Context, MiddlewareHandler } from 'hono';

import { negotiate } from './negotiate.js';
import { resolveOptions, type Settings } from './options.js';
import { appendVary, canCompressBody, isCandidate, meetsThreshold, weakenEtag } from './shared.js';
import type { ComprsOptions, Encoding, LevelOptions } from './types.js';
import { toZlib } from './zlib.js';

/** Hono-specific options (filter receives Hono Context). */
export interface HonoComprsOptions extends Omit<ComprsOptions, 'filter'> {
  /**
   * Filter function to decide whether to compress a response.
   * Return `true` to compress, `false` to skip.
   *
   * The filter narrows the built-in checks rather than replacing them; see
   * {@link ComprsOptions.filter}.
   */
  filter?: (c: Context) => boolean;
}

function compressBuffer(encoding: Encoding, data: Uint8Array, level?: LevelOptions): Uint8Array {
  switch (encoding) {
    case 'zstd':
      return zstdCompress(data, level?.zstd);
    case 'br':
      return brotliCompress(data, level?.br);
    case 'gzip':
      return gzipCompress(data, level?.gzip);
    case 'deflate':
      return toZlib(deflateCompress(data, level?.deflate), data, level?.deflate);
  }
}

/**
 * Decide on the encoding from the request and the response headers, adding
 * Vary to a response that could be compressed. Returns null when the
 * response is sent as it is.
 */
function selectEncoding(
  c: Context,
  settings: Settings,
  filter: HonoComprsOptions['filter'],
): Encoding | null {
  const header = (name: string): string | undefined => c.res.headers.get(name) ?? undefined;
  if (!isCandidate(header, () => !filter || filter(c))) return null;
  // Set even when this request gets no encoding, including HEAD requests:
  // other requests may.
  c.header('Vary', appendVary(header('vary')));

  if (c.req.method === 'HEAD' || c.res.body === null) return null;
  if (!canCompressBody(c.res.status, c.res.headers.has('content-range'))) return null;

  // Early threshold check via Content-Length to avoid reading the body
  const contentLength = header('content-length');
  if (
    contentLength !== undefined &&
    !meetsThreshold(Number.parseInt(contentLength, 10), settings.threshold)
  ) {
    return null;
  }
  return negotiate(c.req.header('accept-encoding'), settings.encodings);
}

/** Replace the response with its compressed version, unless its body is below the threshold. */
async function compressResponse(c: Context, encoding: Encoding, settings: Settings): Promise<void> {
  // Clone before reading body so we can fall back to original on error or below threshold
  try {
    const cloned = c.res.clone();
    const body = await cloned.arrayBuffer();
    const data = new Uint8Array(body);

    if (!meetsThreshold(data.length, settings.threshold)) return;

    const compressed = compressBuffer(encoding, data, settings.level);

    c.res = new Response(compressed, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers: c.res.headers,
    });
    // Assigning c.res copies the previous response's headers over the new
    // one's, so the headers that compression changes are set afterwards.
    const { headers } = c.res;
    headers.set('Content-Encoding', encoding);
    headers.delete('Content-Length');
    const etag = headers.get('etag');
    if (etag) headers.set('ETag', weakenEtag(etag));
  } catch {
    // Compression failed — fall back to original unmodified response
  }
}

/**
 * Hono compression middleware.
 *
 * Uses synchronous compression since Hono processes the response body at once
 * via the Web Standards Response API.
 *
 * @throws {TypeError | RangeError} When an option is invalid.
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
  const settings = resolveOptions(options);
  const { filter } = options;

  return async (c, next) => {
    await next();
    const encoding = selectEncoding(c, settings, filter);
    if (encoding) await compressResponse(c, encoding, settings);
  };
}
