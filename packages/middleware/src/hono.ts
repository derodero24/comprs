import type { Context, MiddlewareHandler } from 'hono';

import { compressBufferAsync, createEncoder, type Encoder } from './compress.js';
import { negotiate } from './negotiate.js';
import { resolveOptions, type Settings } from './options.js';
import { appendVary, canCompressBody, isCandidate, meetsThreshold, weakenEtag } from './shared.js';
import type { ComprsOptions, Encoding } from './types.js';

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

type Reader = ReadableStreamDefaultReader<Uint8Array>;
type ReadResult = Awaited<ReturnType<Reader['read']>>;
type Controller = ReadableStreamDefaultController<Uint8Array>;

/**
 * Bytes of a body read ahead to find out whether it ends at once, in which
 * case it is compressed in one call. Reading stops past this size, so that
 * a stream that produces data quickly is not buffered whole.
 */
const READ_AHEAD_LIMIT = 1024 * 1024;

/** What a body had ready when it was read ahead. */
interface ReadAhead {
  /** The chunks read. */
  chunks: Uint8Array[];
  /** Whether the chunks are the whole body. */
  done: boolean;
  /** A read that is still waiting for the body's producer. */
  pending: Promise<ReadResult> | undefined;
}

/**
 * Resolve with null once the event loop has run the work that is ready now,
 * pending promise jobs and I/O callbacks included. A read of a body that is
 * still pending by then waits for the body's producer.
 */
function nextTurn(): Promise<null> {
  return new Promise((resolve) => {
    setImmediate(() => resolve(null));
  });
}

/**
 * Read the chunks a body has ready, without waiting for its producer.
 * Reading stops at the end of the body, at a chunk that is not ready, or
 * past READ_AHEAD_LIMIT bytes, or `threshold` bytes if that is more.
 */
async function readAhead(reader: Reader, threshold: number): Promise<ReadAhead> {
  const limit = Math.max(READ_AHEAD_LIMIT, threshold);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const pending = reader.read();
    const result = await Promise.race([pending, nextTurn()]);
    if (result === null) return { chunks, done: false, pending };
    if (result.done) return { chunks, done: true, pending: undefined };
    chunks.push(result.value);
    // Checked before the chunk counts, so that the end of a body that came
    // in one large chunk is still found.
    if (size >= limit) return { chunks, done: false, pending: undefined };
    size += result.value.byteLength;
  }
}

/** Join the chunks of a body. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const [first] = chunks;
  return chunks.length === 1 && first ? first : Buffer.concat(chunks);
}

/** Enqueue compressed output, if there is any; returns whether there was. */
function enqueue(controller: Controller, output: Uint8Array): boolean {
  if (output.byteLength === 0) return false;
  controller.enqueue(output);
  return true;
}

/**
 * Compress the rest of a body while it is sent, starting with the chunks
 * read ahead. The body is read only as fast as the compressed stream is.
 * The encoder is flushed whenever the body has no chunk ready, so that a
 * stream that produces data slowly, or never ends, reaches the client as it
 * is produced, while chunks that come together are compressed together.
 */
function compressStream(
  reader: Reader,
  ahead: ReadAhead,
  encoder: Encoder,
): ReadableStream<Uint8Array> {
  // Reversed, so that pop() takes the next chunk in constant time.
  const queued = ahead.chunks.reverse();
  let { pending } = ahead;
  /** Whether the encoder holds input that was not flushed. */
  let unflushed = false;
  let cancelled = false;

  /** Compress the next chunk; returns whether the stream got output or ended. */
  const step = async (controller: Controller): Promise<boolean> => {
    const chunk = queued.pop();
    if (chunk) {
      unflushed = true;
      return enqueue(controller, encoder.transform(chunk));
    }
    pending ??= reader.read();
    if (unflushed && (await Promise.race([pending, nextTurn()])) === null) {
      // The body has nothing ready: send what it gave so far.
      unflushed = false;
      return cancelled || enqueue(controller, encoder.flush());
    }
    const result = await pending;
    pending = undefined;
    if (cancelled) return true;
    if (result.done) {
      enqueue(controller, encoder.finish());
      controller.close();
      return true;
    }
    unflushed = true;
    return enqueue(controller, encoder.transform(result.value));
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let sent = false;
        while (!sent) sent = await step(controller);
      } catch (err) {
        // Stop the body too, as nothing reads it any more; a body that
        // failed by itself refuses to be cancelled.
        reader.cancel(err).catch(() => {});
        throw err;
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason);
    },
  });
}

/**
 * Replace the body of the response, keeping its status and headers, and mark
 * it as compressed with `encoding` unless that is null.
 */
function replaceBody(
  c: Context,
  body: Uint8Array | ReadableStream<Uint8Array>,
  encoding: Encoding | null,
): void {
  const { status, statusText } = c.res;
  c.res = new Response(body, { status, statusText, headers: c.res.headers });
  // Assigning c.res copies the previous response's headers over the new
  // one's, so the headers that change are set afterwards.
  const { headers } = c.res;
  // A body in memory has a known length, which the server sends as
  // Content-Length; the chunked Transfer-Encoding that streamText() and
  // streamSSE() set would contradict it.
  if (body instanceof Uint8Array) headers.delete('Transfer-Encoding');
  if (!encoding) return;
  headers.set('Content-Encoding', encoding);
  headers.delete('Content-Length');
  const etag = headers.get('etag');
  if (etag) headers.set('ETag', weakenEtag(etag));
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

/**
 * Replace the response with its compressed version. A body that ends at
 * once is compressed in one call off the event loop, unless it is below the
 * threshold; any other body is compressed while it is sent. Errors raised
 * before the response is replaced propagate to Hono's error handler.
 */
async function compressResponse(
  c: Context,
  body: ReadableStream<Uint8Array>,
  encoding: Encoding,
  settings: Settings,
): Promise<void> {
  const reader: Reader = body.getReader();
  try {
    const ahead = await readAhead(reader, settings.threshold);
    if (!ahead.done) {
      const encoder = createEncoder(encoding, settings.level);
      replaceBody(c, compressStream(reader, ahead, encoder), encoding);
      return;
    }
    const data = concat(ahead.chunks);
    if (!meetsThreshold(data.byteLength, settings.threshold)) {
      replaceBody(c, data, null);
      return;
    }
    replaceBody(c, await compressBufferAsync(encoding, data, settings.level), encoding);
  } catch (err) {
    // The response is replaced by the error handler's, so nothing reads the
    // body any more; a body that failed by itself refuses to be cancelled.
    reader.cancel(err).catch(() => {});
    throw err;
  }
}

/**
 * Hono compression middleware.
 *
 * A body that is complete when the handler returns, such as that of
 * `c.text()` or `c.json()`, is compressed in one call on the libuv thread
 * pool, so the event loop is not held up. Any other body, such as that of
 * `stream()` or `streamText()`, is compressed while it is sent: whenever the
 * handler pauses, the client receives what it has written, so a stream that
 * never ends still flows. An error that occurs before the response is sent,
 * such as a body stream that fails at once, is passed to Hono's error
 * handler; a body stream that fails later aborts the response.
 *
 * The middleware compresses with the native addon of `@derodero24/comprs`:
 * it runs on Node.js and Bun, not on edge runtimes such as Cloudflare
 * Workers.
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
    const { body } = c.res;
    if (encoding && body) await compressResponse(c, body, encoding, settings);
  };
}
