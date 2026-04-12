import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Transform } from 'node:stream';

import { createCompressTransform } from './compress.js';
import { negotiate } from './negotiate.js';
import { appendVary, DEFAULT_ENCODINGS, DEFAULT_THRESHOLD, isCompressibleType } from './shared.js';
import type { ComprsOptions, Encoding } from './types.js';

/** Check if compression should be skipped for this response. */
function shouldSkip(
  req: IncomingMessage,
  res: ServerResponse,
  threshold: number,
  filter: ComprsOptions['filter'],
): boolean {
  if (res.getHeader('content-encoding')) return true;

  const cacheControl = res.getHeader('cache-control');
  if (typeof cacheControl === 'string' && cacheControl.includes('no-transform')) return true;

  if (filter && !filter(req, res)) return true;

  if (!isCompressibleType(res.getHeader('content-type') as string | undefined)) return true;

  const contentLength = res.getHeader('content-length');
  if (contentLength !== undefined) {
    const len =
      typeof contentLength === 'string' ? Number.parseInt(contentLength, 10) : contentLength;
    if (typeof len === 'number' && len < threshold) return true;
  }

  return false;
}

function ensureVaryHeader(res: ServerResponse): void {
  const vary = res.getHeader('vary');
  const varyStr = Array.isArray(vary) ? vary.join(', ') : (vary as string | undefined);
  res.setHeader('Vary', appendVary(varyStr));
}

/** Set up the compression stream and wire it to the response. */
function initCompression(
  res: ServerResponse,
  encoding: Encoding,
  level: ComprsOptions['level'],
  originalWrite: ServerResponse['write'],
  originalEnd: ServerResponse['end'],
): Transform {
  const stream = createCompressTransform(encoding, level);

  res.setHeader('Content-Encoding', encoding);
  res.removeHeader('Content-Length');
  ensureVaryHeader(res);

  stream.on('data', (chunk: Buffer) => {
    // biome-ignore lint/suspicious/noExplicitAny: calling original write with raw chunk
    (originalWrite as any).call(res, chunk);
  });
  stream.on('end', () => {
    // biome-ignore lint/suspicious/noExplicitAny: calling original end to finalize response
    (originalEnd as any).call(res);
  });
  stream.on('error', (err) => {
    res.removeHeader('Content-Encoding');
    res.destroy(err);
  });

  return stream;
}

/**
 * Create an Express/Connect HTTP compression middleware.
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { comprs } from '@derodero24/comprs-middleware/express';
 *
 * const app = express();
 * app.use(comprs({ encodings: ['zstd', 'br', 'gzip'] }));
 * ```
 */
export function comprs(options: ComprsOptions = {}) {
  const {
    encodings = [...DEFAULT_ENCODINGS] as Encoding[],
    threshold = DEFAULT_THRESHOLD,
    level,
    filter,
  } = options;

  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.method === 'HEAD') {
      next();
      return;
    }

    const negotiated = negotiate(req.headers['accept-encoding'] as string | undefined, encodings);
    if (!negotiated) {
      next();
      return;
    }
    const selectedEncoding: Encoding = negotiated;

    const originalWrite = res.write;
    const originalEnd = res.end;
    let compressStream: Transform | null = null;
    let started = false;
    let ended = false;

    // biome-ignore lint/suspicious/noExplicitAny: normalizing Node.js stream overloads
    function normalizeArgs(chunkOrCb?: any, encodingOrCb?: any, cb?: any) {
      const callback =
        typeof chunkOrCb === 'function'
          ? chunkOrCb
          : typeof encodingOrCb === 'function'
            ? encodingOrCb
            : typeof cb === 'function'
              ? cb
              : undefined;
      const chunk = typeof chunkOrCb === 'function' ? undefined : chunkOrCb;
      const encoding =
        typeof encodingOrCb === 'string' ? (encodingOrCb as BufferEncoding) : undefined;
      return { chunk, encoding, callback };
    }

    function trySetup(): boolean {
      if (started) return compressStream !== null;
      started = true;
      if (shouldSkip(req, res, threshold, filter)) return false;
      compressStream = initCompression(res, selectedEncoding, level, originalWrite, originalEnd);
      return true;
    }

    // biome-ignore lint/suspicious/noExplicitAny: Express res.write has complex overloads
    res.write = function patchedWrite(chunk: any, ...args: any[]): boolean {
      const n = normalizeArgs(chunk, args[0], args[1]);
      if (ended) return false;
      if (!started && !trySetup()) {
        // biome-ignore lint/suspicious/noExplicitAny: passing through original args
        return (originalWrite as any).call(res, n.chunk, n.encoding, n.callback);
      }
      if (compressStream) {
        return n.encoding
          ? compressStream.write(n.chunk, n.encoding, n.callback)
          : compressStream.write(n.chunk, n.callback);
      }
      // biome-ignore lint/suspicious/noExplicitAny: passing through original args
      return (originalWrite as any).call(res, n.chunk, n.encoding, n.callback);
    };

    // biome-ignore lint/suspicious/noExplicitAny: Express res.end has complex overloads
    res.end = function patchedEnd(chunk?: any, ...args: any[]): ServerResponse {
      const n = normalizeArgs(chunk, args[0], args[1]);
      if (ended) {
        n.callback?.();
        return res;
      }
      ended = true;

      if (!started && n.chunk != null) {
        const enc = n.encoding ?? 'utf8';
        const buf = Buffer.isBuffer(n.chunk) ? n.chunk : Buffer.from(n.chunk, enc);
        if (buf.length < threshold) {
          ensureVaryHeader(res);
          // biome-ignore lint/suspicious/noExplicitAny: passing through original args
          return (originalEnd as any).call(res, n.chunk, n.encoding, n.callback);
        }
        if (!res.getHeader('content-length')) {
          res.setHeader('content-length', buf.length);
        }
      }

      if (!started && !trySetup()) {
        ensureVaryHeader(res);
        // biome-ignore lint/suspicious/noExplicitAny: passing through original args
        return (originalEnd as any).call(res, n.chunk, n.encoding, n.callback);
      }

      if (compressStream) {
        if (n.chunk != null) {
          n.encoding
            ? compressStream.end(n.chunk, n.encoding, n.callback)
            : compressStream.end(n.chunk, n.callback);
        } else {
          compressStream.end(n.callback);
        }
        return res;
      }

      // biome-ignore lint/suspicious/noExplicitAny: passing through original args
      return (originalEnd as any).call(res, n.chunk, n.encoding, n.callback);
    };

    next();
  };
}
