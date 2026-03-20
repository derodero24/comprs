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
