import type { IncomingMessage, ServerResponse } from 'node:http';

/** Supported HTTP content encodings. */
export type Encoding = 'zstd' | 'br' | 'gzip' | 'deflate';

/**
 * Compression level configuration per algorithm. Each level must be an
 * integer in the range given; other values make the middleware factory throw.
 */
export interface LevelOptions {
  /**
   * zstd compression level (-131072 to 19; negative levels are fast modes). Default: 3.
   *
   * Levels 20 to 22 are not accepted: they need a window larger than the
   * 8 MiB that RFC 9659 allows for the `zstd` content coding, which Chromium
   * enforces.
   */
  zstd?: number;
  /** Brotli compression quality (0-11). Default: 6. */
  br?: number;
  /** Gzip compression level (0-9). Default: 6. */
  gzip?: number;
  /** Deflate compression level (0-9). Default: 6. */
  deflate?: number;
}

/** Options for the compression middleware. */
export interface ComprsOptions {
  /**
   * Encodings to use, most preferred first; must not be empty. The first one
   * the client accepts wins: the weights in Accept-Encoding only rule an
   * encoding out (`q=0`), they do not reorder this list.
   * @default ['zstd', 'br', 'gzip', 'deflate']
   */
  encodings?: readonly Encoding[];

  /**
   * Minimum response size in bytes to trigger compression; a finite number
   * of 0 or more. Responses smaller than this are sent uncompressed, and so
   * are empty ones. Streamed responses of unknown size are compressed.
   * @default 1024
   */
  threshold?: number;

  /** Per-algorithm compression levels. */
  level?: LevelOptions;

  /**
   * Filter function to decide whether to compress a response.
   * Return `true` to compress, `false` to skip.
   * Called after headers are set but before response body is sent.
   *
   * The filter narrows the built-in checks rather than replacing them: a
   * response is only compressed when the filter returns `true` and the
   * response has a compressible Content-Type (text, JSON, XML, etc., but not
   * `text/event-stream`), no Content-Encoding and no `Cache-Control:
   * no-transform`. The filter also decides whether `Vary: Accept-Encoding` is
   * added, so it is called for requests that are not compressed as well,
   * such as HEAD requests.
   * @default Compresses every response that passes the built-in checks
   */
  filter?: (req: IncomingMessage, res: ServerResponse) => boolean;
}
