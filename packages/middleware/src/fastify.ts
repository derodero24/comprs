import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

import { compressBufferAsync, createCompressTransform } from './compress.js';
import { negotiate } from './negotiate.js';
import { checkCallback, resolveOptions, type Settings } from './options.js';
import {
  appendVary,
  canCompressBody,
  headerValue,
  isCandidate,
  meetsThreshold,
  weakenEtag,
} from './shared.js';
import type { ComprsOptions, Encoding } from './types.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Set to `false` to have the comprs plugin leave the replies of this
     * route alone: they are neither compressed nor given
     * `Vary: Accept-Encoding`.
     */
    compress?: boolean;
  }
}

/** Fastify-specific options. */
export interface FastifyComprsOptions extends ComprsOptions {
  /**
   * Decide whether to compress a reply, given the Fastify request and reply.
   * Return `true` to compress, `false` to skip.
   *
   * The reply has the headers set with `reply.header()` or `reply.type()`,
   * and those of a `Response` payload. Like `filter`, this narrows the
   * built-in checks rather than replacing them; see
   * {@link ComprsOptions.filter}. When both are given, a reply is only
   * compressed when both return `true`.
   */
  shouldCompress?: (request: FastifyRequest, reply: FastifyReply) => boolean;

  /**
   * Filter function that receives the raw Node.js request and response
   * (`request.raw` and `reply.raw`). Return `true` to compress, `false` to
   * skip.
   *
   * The headers set with `reply.header()` or `reply.type()`, and those of a
   * `Response` payload, are not on the raw response yet when it runs, so a
   * filter that reads response headers should use `shouldCompress` instead.
   * Like `shouldCompress`, this narrows the built-in checks; see
   * {@link ComprsOptions.filter}.
   */
  filter?: (req: IncomingMessage, res: ServerResponse) => boolean;
}

/** Runs the user's filters on a reply. */
type Filter = (request: FastifyRequest, reply: FastifyReply) => boolean;

/** Read a reply header field as one string. */
function replyHeader(reply: FastifyReply, name: string): string | undefined {
  return headerValue(reply.getHeader(name));
}

/**
 * Apply the status and headers of a `Response` payload to the reply and
 * return its body, as Fastify does once the onSend hooks have run, so that
 * the decision to compress sees them. A Response whose body was already read
 * is returned as it is, for Fastify to reject.
 */
function unwrapResponse(reply: FastifyReply, payload: unknown): unknown {
  if (!(payload instanceof Response) || payload.bodyUsed) {
    return payload;
  }
  reply.code(payload.status);
  for (const [name, value] of payload.headers) {
    reply.header(name, value);
  }
  return payload.body;
}

/**
 * Decide on the encoding from the request and the reply headers, adding Vary
 * to a reply that could be compressed. Returns null when the reply is sent
 * as it is.
 */
function selectEncoding(
  request: FastifyRequest,
  reply: FastifyReply,
  settings: Settings,
  filter: Filter,
): Encoding | null {
  const header = (name: string): string | undefined => replyHeader(reply, name);
  if (!isCandidate(header, () => filter(request, reply))) {
    return null;
  }
  // Set even when this request gets no encoding, including HEAD requests:
  // other requests may.
  reply.header('Vary', appendVary(header('vary')));

  if (request.method === 'HEAD') {
    return null;
  }
  if (!canCompressBody(reply.statusCode, reply.hasHeader('content-range'))) {
    return null;
  }
  return negotiate(request.headers['accept-encoding'], settings.encodings);
}

/** Mark the reply as compressed with `encoding`. */
function setEncodingHeaders(reply: FastifyReply, encoding: Encoding): void {
  reply.header('Content-Encoding', encoding);
  reply.removeHeader('Content-Length');
  const etag = replyHeader(reply, 'etag');
  if (etag) {
    reply.header('ETag', weakenEtag(etag));
  }
}

/**
 * Compress a stream payload while it is sent. Its size is unknown, so the
 * threshold only applies when the reply declares a Content-Length.
 */
function compressStream(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: Readable | ReadableStream,
  encoding: Encoding,
  settings: Settings,
): Readable | ReadableStream {
  const declared = replyHeader(reply, 'content-length');
  if (
    declared !== undefined &&
    !meetsThreshold(Number.parseInt(declared, 10), settings.threshold)
  ) {
    return payload;
  }

  const source = payload instanceof Readable ? payload : Readable.fromWeb(payload);
  const stream = createCompressTransform(encoding, settings.level);
  setEncodingHeaders(reply, encoding);
  pipeline(source, stream).catch((err: NodeJS.ErrnoException) => {
    // Premature close is expected when clients disconnect mid-stream
    if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      request.log.debug(err, 'comprs: compression pipeline error');
    }
  });
  return stream;
}

/**
 * Compress a payload that is in memory in one call. Fastify then sets the
 * Content-Length of the compressed body, unless the reply has trailers and
 * is sent chunked. If compression fails, the payload is sent uncompressed.
 */
async function compressBuffered(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: string | Uint8Array,
  encoding: Encoding,
  settings: Settings,
): Promise<string | Uint8Array> {
  const data = typeof payload === 'string' ? Buffer.from(payload) : payload;
  if (!meetsThreshold(data.byteLength, settings.threshold)) {
    return payload;
  }

  let compressed: Buffer;
  try {
    compressed = await compressBufferAsync(encoding, data, settings.level);
  } catch (err) {
    request.log.warn({ err }, 'comprs: compression failed, sending the reply uncompressed');
    return payload;
  }
  setEncodingHeaders(reply, encoding);
  return compressed;
}

const plugin: FastifyPluginAsync<FastifyComprsOptions> = async (
  fastify: FastifyInstance,
  options: FastifyComprsOptions,
) => {
  const settings = resolveOptions(options);
  checkCallback('shouldCompress', options.shouldCompress);
  const { filter, shouldCompress } = options;
  const passesFilters: Filter = (request: FastifyRequest, reply: FastifyReply) =>
    (!filter || filter(request.raw, reply.raw)) &&
    (!shouldCompress || shouldCompress(request, reply));

  fastify.addHook('onSend', async (request, reply, payload) => {
    if (request.routeOptions.config.compress === false) {
      return payload;
    }
    const body = unwrapResponse(reply, payload);
    const encoding = selectEncoding(request, reply, settings, passesFilters);
    if (!encoding) {
      return body;
    }

    if (body instanceof Readable || body instanceof ReadableStream) {
      return compressStream(request, reply, body, encoding, settings);
    }
    if (typeof body === 'string' || body instanceof Uint8Array) {
      return compressBuffered(request, reply, body, encoding, settings);
    }
    return body;
  });
};

/**
 * Fastify compression plugin.
 *
 * `string`, `Buffer` and `Uint8Array` payloads are compressed in one call
 * off the event loop and sent with a Content-Length; Node.js streams, Web
 * `ReadableStream`s and the body of a `Response` are compressed while they
 * are sent. Whenever such a stream stops producing data, the client
 * receives what it has produced so far, so a stream that never ends still
 * flows. Set `config: { compress: false }` on a route to leave its replies
 * alone.
 *
 * The plugin is wrapped with `fastify-plugin`: it applies to the routes of
 * the context it is registered in, including those of child contexts, and
 * it is named `@derodero24/comprs-middleware` for plugin dependencies.
 * Registration fails with a TypeError or RangeError when an option is
 * invalid.
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
export const comprs: FastifyPluginAsync<FastifyComprsOptions> = fastifyPlugin(plugin, {
  name: '@derodero24/comprs-middleware',
  fastify: '5.x',
});
