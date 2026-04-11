import type { IncomingMessage, ServerResponse } from 'node:http';

/** Supported HTTP content encodings. */
export type Encoding = 'zstd' | 'br' | 'gzip' | 'deflate';

/** Compression level configuration per algorithm. */
export interface LevelOptions {
  /** zstd compression level (1-22, or negative for fast mode). Default: 3. */
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
   * Algorithm priority order. The first encoding accepted by the client wins.
   * @default ['zstd', 'br', 'gzip', 'deflate']
   */
  encodings?: Encoding[];

  /**
   * Minimum response size in bytes to trigger compression.
   * Responses smaller than this are sent uncompressed.
   * @default 1024
   */
  threshold?: number;

  /** Per-algorithm compression levels. */
  level?: LevelOptions;

  /**
   * Filter function to decide whether to compress a response.
   * Return `true` to compress, `false` to skip.
   * Called after headers are set but before response body is sent.
   * @default Compresses text-based content types
   */
  filter?: (req: IncomingMessage, res: ServerResponse) => boolean;
}
