// Types of the browser module of `@derodero24/comprs/streams` (streams.js),
// which builds the helpers of ../streams.js on the stream contexts of the
// browser entry. They are those of ../streams.d.ts, with `Uint8Array` where
// those take `Buffer | Uint8Array`; __test__/browser-streams.spec.ts checks
// that they agree.

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
 * The stream errors if the input ends before the compressed stream does,
 * including empty input.
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
 * The stream errors if the input ends before the compressed stream does,
 * including empty input.
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
 * The stream errors if the input ends before the compressed stream does,
 * including empty input.
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
 * The stream errors if the input ends before the compressed stream does,
 * including empty input.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createDeflateDecompressStream(
  maxOutputSize?: number,
): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming LZ4 frame compression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked LZ4 compression.
 */
export declare function createLz4CompressStream(): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming LZ4 frame decompression TransformStream.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked LZ4 decompression.
 *
 * The stream errors on empty input.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createLz4DecompressStream(
  maxOutputSize?: number,
): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming brotli compression TransformStream with a custom dictionary.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked compression
 * with a custom dictionary for improved compression of similar data.
 *
 * @param dict Custom dictionary bytes.
 * @param quality Compression quality (0-11). Default is 6.
 */
export declare function createBrotliCompressDictStream(
  dict: Uint8Array,
  quality?: number,
): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming brotli decompression TransformStream with a custom dictionary.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked decompression
 * with a custom dictionary. The same dictionary used for compression must be provided.
 *
 * The stream errors if the input ends before the compressed stream does,
 * including empty input.
 *
 * @param dict Custom dictionary (must match the one used for compression).
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createBrotliDecompressDictStream(
  dict: Uint8Array,
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
  dict: Uint8Array,
  level?: number,
): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming zstd decompression TransformStream with a pre-trained dictionary.
 *
 * Uses the Web Streams API (`TransformStream`) to provide chunked decompression
 * with a pre-trained dictionary. The same dictionary used for compression must be provided.
 *
 * The stream errors if the input ends before the compressed stream does,
 * including empty input.
 *
 * @param dict Pre-trained dictionary (must match the one used for compression).
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createZstdDecompressDictStream(
  dict: Uint8Array,
  maxOutputSize?: number,
): TransformStream<Uint8Array, Uint8Array>;

/**
 * Create a streaming auto-detect decompression TransformStream.
 *
 * Detects the compression format (zstd, gzip, brotli, or lz4) like
 * `detectFormat` and delegates to the appropriate decompression context.
 * Raw deflate is not supported (no magic bytes to distinguish it).
 *
 * The input is buffered until the format is detected: up to 64 KiB, or the
 * whole input if it is shorter, since brotli has no magic bytes and its
 * detection may need that much. The stream errors if the format is still
 * unknown then.
 *
 * The stream errors on empty input, which has no format to detect, and on
 * zstd, gzip or brotli input that ends before the compressed stream does.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createDecompressStream(
  maxOutputSize?: number,
): TransformStream<Uint8Array, Uint8Array>;
