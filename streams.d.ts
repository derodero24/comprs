/**
 * Create a streaming brotli compression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked compression.
 * Data compressed across multiple chunks maintains cross-chunk context for
 * optimal compression ratio.
 *
 * @param quality Compression quality (0-11). Default is 6.
 */
export declare function createBrotliCompressStream(
  quality?: number,
): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming brotli decompression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked decompression.
 */
export declare function createBrotliDecompressStream(): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming zstd compression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked compression.
 * Data compressed across multiple chunks maintains cross-chunk context for
 * optimal compression ratio.
 *
 * @param level Compression level (1-22, or negative for fast mode). Default is 3.
 */
export declare function createZstdCompressStream(
  level?: number,
): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming zstd decompression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked decompression.
 */
export declare function createZstdDecompressStream(): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming gzip compression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked gzip compression.
 * Produces spec-compliant gzip output with proper header and CRC32 footer.
 *
 * @param level Compression level (0-9). Default is 6.
 */
export declare function createGzipCompressStream(
  level?: number,
): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming gzip decompression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked gzip decompression.
 * Verifies CRC32 integrity on finalization.
 */
export declare function createGzipDecompressStream(): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming raw deflate compression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked raw deflate
 * compression (no gzip header/footer).
 *
 * @param level Compression level (0-9). Default is 6.
 */
export declare function createDeflateCompressStream(
  level?: number,
): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming raw deflate decompression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked raw deflate
 * decompression.
 */
export declare function createDeflateDecompressStream(): TransformStream<Uint8Array, Uint8Array>;
