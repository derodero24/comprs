import type {
  IncomingMessage,
  OutgoingHttpHeader,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';
import type { Transform } from 'node:stream';

import { createCompressTransform } from './compress.js';
import { negotiate } from './negotiate.js';
import { resolveOptions } from './options.js';
import {
  appendVary,
  canCompressBody,
  hasBody,
  headerValue,
  isCandidate,
  meetsThreshold,
  weakenEtag,
} from './shared.js';
import type { ComprsOptions, Encoding } from './types.js';

type Chunk = string | Uint8Array;
type WriteCallback = (error: Error | null | undefined) => void;
type EndCallback = () => void;
type HeaderFields = OutgoingHttpHeaders | OutgoingHttpHeader[];

interface EndArgs {
  chunk: Chunk | undefined;
  encoding: BufferEncoding | undefined;
  callback: EndCallback | undefined;
}

interface Settings {
  /** The negotiated encoding; null when the response must not be compressed. */
  encoding: Encoding | null;
  threshold: number;
  level: ComprsOptions['level'];
  filter: ComprsOptions['filter'];
}

/** The headers a decision to compress changes, to restore if it is undone. */
interface Snapshot {
  statusCode: number;
  contentLength: OutgoingHttpHeader | undefined;
  etag: OutgoingHttpHeader | undefined;
}

/** Restore a header to a value read with `getHeader()`, removing it if there was none. */
function restoreHeader(
  res: ServerResponse,
  name: string,
  value: OutgoingHttpHeader | undefined,
): void {
  if (res.getHeader(name) === value) return;
  if (value === undefined) res.removeHeader(name);
  else res.setHeader(name, value);
}

/** Pair up a flat `[name, value, ...]` header array; undefined if malformed. */
function headerPairs(fields: OutgoingHttpHeader[]): [string, string | string[]][] | undefined {
  if (fields.length % 2 !== 0) return undefined;
  const pairs: [string, string | string[]][] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const name = fields[i];
    const value = fields[i + 1];
    if (typeof name !== 'string' || value === undefined) return undefined;
    pairs.push([name, typeof value === 'number' ? String(value) : value]);
  }
  return pairs;
}

/**
 * Merge the header fields passed to `writeHead()` into the response the way
 * `writeHead()` does, so that the compression decision can read and change
 * them. Returns false without changing anything when the fields have a shape
 * this does not handle; `writeHead()` then receives them as they are.
 */
function setHeaderFields(res: ServerResponse, fields: HeaderFields): boolean {
  if (Array.isArray(fields)) {
    const pairs = headerPairs(fields);
    if (!pairs) return false;
    // Replace earlier values, but keep the duplicates within the array.
    for (const [name] of pairs) res.removeHeader(name);
    for (const [name, value] of pairs) res.appendHeader(name, value);
    return true;
  }
  const entries = Object.entries(fields);
  if (entries.some(([, value]) => value === undefined)) return false;
  for (const [name, value] of entries) {
    if (value !== undefined) res.setHeader(name, value);
  }
  return true;
}

/**
 * Restore the Content-Length that Node derives from `end(body)`. Node only
 * does so when `end()` emits the headers itself, and here `writeHead()` has
 * already been called to make the compression decision. Like Node, leave out
 * responses without content and responses to HEAD requests, whose
 * Content-Length would have to be that of the GET response.
 */
function keepBodyLength(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  length: number,
): void {
  if (req.method === 'HEAD' || !hasBody(statusCode)) return;
  for (const name of ['content-length', 'transfer-encoding', 'trailer']) {
    if (res.hasHeader(name)) return;
  }
  res.setHeader('Content-Length', length);
}

/** Size of a body chunk in bytes; 0 when there is none. */
function byteLength(chunk: Chunk | undefined, encoding: BufferEncoding | undefined): number {
  if (chunk === undefined) return 0;
  return typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
}

/** Sort out the optional arguments of `end()` the way `ServerResponse` does. */
function endArgs(
  chunkOrCallback: Chunk | EndCallback | null | undefined,
  encodingOrCallback: BufferEncoding | EndCallback | undefined,
  callback: EndCallback | undefined,
): EndArgs {
  if (typeof chunkOrCallback === 'function') {
    return { chunk: undefined, encoding: undefined, callback: chunkOrCallback };
  }
  const chunk = chunkOrCallback ?? undefined;
  if (typeof encodingOrCallback === 'function') {
    return { chunk, encoding: undefined, callback: encodingOrCallback };
  }
  return { chunk, encoding: encodingOrCallback, callback };
}

/** End the compressor, writing the final chunk if there is one. */
function endStream(stream: Transform, { chunk, encoding }: EndArgs): void {
  if (chunk === undefined) stream.end();
  else if (encoding === undefined) stream.end(chunk);
  else stream.end(chunk, encoding);
}

/**
 * Fail a write that comes after `end()` the way `ServerResponse` does: return
 * false, then pass `ERR_STREAM_WRITE_AFTER_END` to the callback and emit it.
 */
function failWriteAfterEnd(res: ServerResponse, callback: WriteCallback | undefined): false {
  const err: NodeJS.ErrnoException = new Error('write after end');
  err.code = 'ERR_STREAM_WRITE_AFTER_END';
  process.nextTick(() => {
    callback?.(err);
    if (!res.destroyed) res.emit('error', err);
  });
  return false;
}

/**
 * Hook `res` so that compression is decided when its headers are emitted.
 *
 * Every way of emitting headers (`writeHead()`, `flushHeaders()`, the first
 * `write()` or `end()`) goes through `res.writeHead()`, which is where the
 * decision is made, like the `on-headers` hook of `compression`. The body
 * methods then feed either the compressor or the original methods. Without
 * an encoding, the decision only adds Vary to a response that could have
 * been compressed.
 */
function compressResponse(req: IncomingMessage, res: ServerResponse, settings: Settings): void {
  const writeHead = res.writeHead.bind(res);
  const write = res.write.bind(res);
  const end = res.end.bind(res);

  /**
   * Whether the decision was made. It stays made if creating the compressor
   * throws, so the response that reports that error is sent uncompressed.
   */
  let decided = false;
  /** Body size, when `end()` emits the headers and so knows the whole body. */
  let bodyLength: number | undefined;
  let compressor: Transform | undefined;

  const writeRaw = (
    chunk: Chunk,
    encoding: BufferEncoding | undefined,
    callback: WriteCallback | undefined,
  ): boolean =>
    encoding === undefined ? write(chunk, callback) : write(chunk, encoding, callback);

  const endRaw = ({ chunk, encoding, callback }: EndArgs): ServerResponse => {
    if (chunk === undefined) return end(callback);
    return encoding === undefined ? end(chunk, callback) : end(chunk, encoding, callback);
  };

  /** Send the compressor's output to the response, honoring backpressure. */
  function pipeToResponse(stream: Transform): void {
    // Wrap the current emit(), keeping any wrapper installed after setup.
    const emit = res.emit.bind(res);
    stream.on('data', (chunk: Buffer) => {
      // Hold compressed output back while the socket is full.
      if (!write(chunk)) stream.pause();
    });
    stream.on('end', () => {
      end();
    });
    stream.on('error', (err) => {
      // The headers are out by now, so aborting is the only way to report it.
      res.destroy(err);
    });
    // Writers are throttled by the compressor's buffer, so its 'drain' is the
    // response's 'drain'.
    stream.on('drain', () => emit('drain'));
    res.emit = (event: string | symbol, ...args: unknown[]): boolean => {
      if (event === 'drain') {
        // The socket drained: let compressed output flow again. Writers still
        // waiting for the compressor get its own 'drain' later.
        stream.resume();
        if (stream.writableNeedDrain) return false;
      }
      return emit(event, ...args);
    };
    // Release the compressor of a response that will never finish.
    res.once('close', () => stream.destroy());
  }

  /** Start compressing if the response qualifies; called before headers go out. */
  function startCompression(): Transform | undefined {
    const header = (name: string): string | undefined => headerValue(res.getHeader(name));
    const filter = (): boolean => !settings.filter || settings.filter(req, res);
    if (!isCandidate(header, filter)) return undefined;
    // Set even when this request gets no encoding: other requests may.
    res.setHeader('Vary', appendVary(header('vary')));
    if (!settings.encoding) return undefined;
    if (!canCompressBody(res.statusCode, res.hasHeader('content-range'))) return undefined;

    const declared = header('content-length');
    const length = declared === undefined ? bodyLength : Number.parseInt(declared, 10);
    if (length !== undefined && !meetsThreshold(length, settings.threshold)) return undefined;

    const stream = createCompressTransform(settings.encoding, settings.level);
    res.setHeader('Content-Encoding', settings.encoding);
    res.removeHeader('Content-Length');
    const etag = header('etag');
    if (etag) res.setHeader('ETag', weakenEtag(etag));
    pipeToResponse(stream);
    return stream;
  }

  /** Revert what the decision changed, for headers that were never emitted. */
  function undoDecision(snapshot: Snapshot): void {
    if (compressor) {
      compressor.destroy();
      compressor = undefined;
      res.removeHeader('Content-Encoding');
      restoreHeader(res, 'etag', snapshot.etag);
    }
    restoreHeader(res, 'content-length', snapshot.contentLength);
    res.statusCode = snapshot.statusCode;
    decided = false;
  }

  /** Decide on compression, then emit the headers. */
  function emitHeaders(statusCode: number, reason: string | undefined): ServerResponse {
    const snapshot: Snapshot = {
      statusCode: res.statusCode,
      contentLength: res.getHeader('content-length'),
      etag: res.getHeader('etag'),
    };
    decided = true;
    res.statusCode = statusCode;
    compressor = startCompression();
    if (!compressor && bodyLength !== undefined) keepBodyLength(req, res, statusCode, bodyLength);

    try {
      return reason === undefined ? writeHead(statusCode) : writeHead(statusCode, reason);
    } catch (err) {
      // writeHead() rejected its arguments before emitting anything, so the
      // error response that usually follows gets a decision of its own.
      if (!res.headersSent) undoDecision(snapshot);
      throw err;
    }
  }

  /** Whether end() was called and the compressor is still flushing. */
  const flushing = (): boolean => compressor?.writableEnded === true && !res.writableEnded;

  res.writeHead = (
    statusCode: number,
    reasonOrFields?: string | HeaderFields,
    fields?: HeaderFields,
  ): ServerResponse => {
    const reason = typeof reasonOrFields === 'string' ? reasonOrFields : undefined;
    // Like writeHead(), take the fields from the last argument without a reason.
    const headerFields = typeof reasonOrFields === 'string' ? fields : (fields ?? reasonOrFields);
    if (!decided && !res.headersSent) {
      // Merge the fields first so that the decision sees them. Fields this
      // cannot merge go to writeHead() as they are, which rejects them or
      // emits them, leaving the response uncompressed.
      if (headerFields === undefined || setHeaderFields(res, headerFields)) {
        return emitHeaders(statusCode, reason);
      }
    }
    return reason === undefined
      ? writeHead(statusCode, headerFields)
      : writeHead(statusCode, reason, headerFields);
  };

  res.write = (
    chunk: Chunk,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (flushing()) return failWriteAfterEnd(res, done);
    if (!res.headersSent) res.writeHead(res.statusCode);
    if (!compressor || compressor.writableEnded) return writeRaw(chunk, encoding, done);
    return encoding === undefined
      ? compressor.write(chunk, done)
      : compressor.write(chunk, encoding, done);
  };

  res.end = (
    chunkOrCallback?: Chunk | EndCallback | null,
    encodingOrCallback?: BufferEncoding | EndCallback,
    callback?: EndCallback,
  ): ServerResponse => {
    const args = endArgs(chunkOrCallback, encodingOrCallback, callback);
    if (flushing()) {
      // Repeated end(), handled like ServerResponse handles it once ended.
      if (args.chunk) failWriteAfterEnd(res, args.callback);
      else if (args.callback) res.once('finish', args.callback);
      return res;
    }
    if (!res.headersSent) {
      bodyLength = byteLength(args.chunk, args.encoding);
      res.writeHead(res.statusCode);
    }
    if (!compressor || compressor.writableEnded) return endRaw(args);

    // Like ServerResponse, call back once the response has been sent.
    if (args.callback) res.once('finish', args.callback);
    endStream(compressor, args);
    return res;
  };
}

/**
 * Create an Express/Connect HTTP compression middleware.
 *
 * The decision to compress is made when the response headers are emitted, so
 * handlers may call `res.writeHead()` or `res.flushHeaders()` before writing
 * the body. `res.write()` reports backpressure from the client as usual, so
 * `stream.pipe(res)` pauses while the client is slow.
 *
 * @throws {TypeError | RangeError} When an option is invalid.
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
export function comprs(
  options: ComprsOptions = {},
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const { encodings, threshold, level } = resolveOptions(options);
  const { filter } = options;

  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    // Every response is hooked: one that could be compressed gets Vary even
    // when this request is not compressed (a HEAD request, or one that
    // accepts none of the encodings).
    const encoding =
      req.method === 'HEAD' ? null : negotiate(req.headers['accept-encoding'], encodings);
    compressResponse(req, res, { encoding, threshold, level, filter });
    next();
  };
}
