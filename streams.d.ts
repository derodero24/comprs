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
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createBrotliDecompressStream(
  maxOutputSize?: number,
): TransformStream<Uint8Array, Uint8Array>;

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
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createZstdDecompressStream(
  maxOutputSize?: number,
): TransformStream<Uint8Array, Uint8Array>;

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
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createGzipDecompressStream(
  maxOutputSize?: number,
): TransformStream<Uint8Array, Uint8Array>;

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
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createDeflateDecompressStream(
  maxOutputSize?: number,
): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming zstd compression TransformStream with a pre-trained dictionary.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked compression
 * with a pre-trained dictionary for improved compression of small, similar data.
 *
 * @param dict Pre-trained dictionary (from `zstdTrainDictionary`).
 * @param level Compression level (1-22, or negative for fast mode). Default is 3.
 */
export declare function createZstdCompressDictStream(
  dict: Buffer | Uint8Array,
  level?: number,
): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming zstd decompression TransformStream with a pre-trained dictionary.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked decompression
 * with a pre-trained dictionary. The same dictionary used for compression must be provided.
 *
 * @param dict Pre-trained dictionary (must match the one used for compression).
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createZstdDecompressDictStream(
  dict: Buffer | Uint8Array,
  maxOutputSize?: number,
): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming auto-detect decompression TransformStream.
 *
 * Detects the compression format (zstd, gzip, or brotli) from the first
 * few bytes and delegates to the appropriate decompression context.
 * Raw deflate is not supported (no magic bytes to distinguish it).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createDecompressStream(
  maxOutputSize?: number,
): TransformStream<Uint8Array, Uint8Array>;
