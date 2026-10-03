import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { createCompressTransform } from './compress.js';
import { negotiate } from './negotiate.js';
import { resolveOptions } from './options.js';
import {
  appendVary,
  canCompressBody,
  headerValue,
  isCandidate,
  meetsThreshold,
  weakenEtag,
} from './shared.js';
import type { ComprsOptions, Encoding } from './types.js';

/** Check whether the reply could be compressed, adding Vary if so. */
function varyIfCandidate(
  request: FastifyRequest,
  reply: FastifyReply,
  filter: ComprsOptions['filter'],
): boolean {
  const header = (name: string): string | undefined => headerValue(reply.getHeader(name));
  if (!isCandidate(header, () => !filter || filter(request.raw, reply.raw))) return false;
  reply.header('Vary', appendVary(header('vary')));
  return true;
}

/** Mark the reply as compressed with `encoding`. */
function setEncodingHeaders(reply: FastifyReply, encoding: Encoding): void {
  reply.header('Content-Encoding', encoding);
  reply.removeHeader('Content-Length');
  const etag = headerValue(reply.getHeader('etag'));
  if (etag) reply.header('ETag', weakenEtag(etag));
}

function payloadToBuffer(payload: unknown): Buffer | null {
  if (typeof payload === 'string') return Buffer.from(payload);
  if (Buffer.isBuffer(payload)) return payload;
  return null;
}

/**
 * Fastify compression plugin.
 *
 * Registration fails with a TypeError or RangeError when an option is invalid.
 *
 * @example
 * ```ts
 * import Fastify from 'fastify';
 * import { comprs } from '@derodero24/comprs-middleware/fastify';
 *
 * const app = Fastify();
 * app.register(comprs, { encodings: ['zstd', 'br', 'gzip'] });
 * ```
 */
const plugin: FastifyPluginAsync<ComprsOptions> = async (fastify, options) => {
  const { encodings, threshold, level } = resolveOptions(options);
  const { filter } = options;

  fastify.addHook('onSend', async (request, reply, payload) => {
    if (!varyIfCandidate(request, reply, filter)) return payload;
    if (request.method === 'HEAD') return payload;
    if (!canCompressBody(reply.statusCode, reply.hasHeader('content-range'))) return payload;

    const encoding = negotiate(request.headers['accept-encoding'], encodings);
    if (!encoding) return payload;

    // Stream payloads: compress on the fly without threshold check (size is unknown).
    // Content-Length is removed since compressed size differs from original.
    if (payload instanceof Readable) {
      const stream = createCompressTransform(encoding, level);
      setEncodingHeaders(reply, encoding);
      pipeline(payload, stream).catch((err: NodeJS.ErrnoException) => {
        // Premature close is expected when clients disconnect mid-stream
        if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          fastify.log.debug(err, 'comprs: compression pipeline error');
        }
      });
      return stream;
    }

    // Handle string/Buffer payloads
    const buf = payloadToBuffer(payload);
    if (!buf || !meetsThreshold(buf.length, threshold)) return payload;

    const stream = createCompressTransform(encoding, level);
    setEncodingHeaders(reply, encoding);

    // Write data on next tick so Fastify has time to set up piping
    process.nextTick(() => {
      stream.end(buf);
    });
    return stream;
  });
};

// Skip Fastify encapsulation so the hook applies to all routes
// This is equivalent to wrapping with fastify-plugin but without the dependency
// biome-ignore lint/suspicious/noExplicitAny: Fastify plugin metadata
(plugin as any)[Symbol.for('skip-override')] = true;

export const comprs = plugin;
