import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { createCompressTransform } from './compress.js';
import { negotiate } from './negotiate.js';
import { appendVary, DEFAULT_ENCODINGS, DEFAULT_THRESHOLD, isCompressibleType } from './shared.js';
import type { ComprsOptions, Encoding } from './types.js';

function shouldSkipHeaders(
  reply: FastifyReply,
  filter: ComprsOptions['filter'],
  request: FastifyRequest,
): boolean {
  if (reply.getHeader('content-encoding')) return true;

  const cacheControl = reply.getHeader('cache-control') as string | undefined;
  if (cacheControl?.toLowerCase().includes('no-transform')) return true;

  if (filter && !filter(request.raw, reply.raw)) return true;

  if (!isCompressibleType(reply.getHeader('content-type') as string | undefined)) return true;

  return false;
}

function payloadToBuffer(payload: unknown): Buffer | null {
  if (typeof payload === 'string') return Buffer.from(payload);
  if (Buffer.isBuffer(payload)) return payload;
  return null;
}

/**
 * Fastify compression plugin.
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
  const {
    encodings = [...DEFAULT_ENCODINGS] as Encoding[],
    threshold = DEFAULT_THRESHOLD,
    level,
    filter,
  } = options;

  fastify.addHook('onSend', async (request, reply, payload) => {
    if (request.method === 'HEAD') return payload;

    const encoding = negotiate(request.headers['accept-encoding'], encodings);

    // Always set Vary
    reply.header('Vary', appendVary(reply.getHeader('vary') as string | undefined));

    if (!encoding) return payload;
    if (shouldSkipHeaders(reply, filter, request)) return payload;

    // Stream payloads: compress on the fly without threshold check (size is unknown).
    // Content-Length is removed since compressed size differs from original.
    if (payload instanceof Readable) {
      const stream = createCompressTransform(encoding, level);
      reply.header('Content-Encoding', encoding);
      reply.removeHeader('Content-Length');
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
    if (!buf) return payload;
    if (buf.length < threshold) return payload;

    const stream = createCompressTransform(encoding, level);
    reply.header('Content-Encoding', encoding);
    reply.removeHeader('Content-Length');

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
