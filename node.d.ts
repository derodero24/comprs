import type { Transform } from 'node:stream';

/**
 * Create a Node.js stream.Transform for zstd compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked compression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 *
 * @param level Compression level (1-22, or negative for fast mode). Default is 3.
 */
export declare function createZstdCompressTransform(level?: number): Transform;

/**
 * Create a Node.js stream.Transform for zstd decompression.
 *
 * Uses Node.js `stream.Transform` to provide chunked decompression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createZstdDecompressTransform(maxOutputSize?: number): Transform;

/**
 * Create a Node.js stream.Transform for gzip compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked gzip compression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 * Produces spec-compliant gzip output with proper header and CRC32 footer.
 *
 * @param level Compression level (0-9). Default is 6.
 */
export declare function createGzipCompressTransform(level?: number): Transform;

/**
 * Create a Node.js stream.Transform for gzip decompression.
 *
 * Uses Node.js `stream.Transform` to provide chunked gzip decompression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 * Verifies CRC32 integrity on finalization.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createGzipDecompressTransform(maxOutputSize?: number): Transform;

/**
 * Create a Node.js stream.Transform for raw deflate compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked raw deflate compression
 * (no gzip header/footer) compatible with `stream.pipeline()` and pipe-based workflows.
 *
 * @param level Compression level (0-9). Default is 6.
 */
export declare function createDeflateCompressTransform(level?: number): Transform;

/**
 * Create a Node.js stream.Transform for raw deflate decompression.
 *
 * Uses Node.js `stream.Transform` to provide chunked raw deflate decompression
 * compatible with `stream.pipeline()` and pipe-based workflows.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createDeflateDecompressTransform(maxOutputSize?: number): Transform;

/**
 * Create a Node.js stream.Transform for brotli compression.
 *
 * Uses Node.js `stream.Transform` to provide chunked brotli compression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 *
 * @param quality Compression quality (0-11). Default is 6.
 */
export declare function createBrotliCompressTransform(quality?: number): Transform;

/**
 * Create a Node.js stream.Transform for brotli decompression.
 *
 * Uses Node.js `stream.Transform` to provide chunked brotli decompression compatible
 * with `stream.pipeline()` and pipe-based workflows.
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createBrotliDecompressTransform(maxOutputSize?: number): Transform;

/**
 * Create a Node.js stream.Transform for zstd compression with a pre-trained dictionary.
 *
 * Uses Node.js `stream.Transform` to provide chunked compression with a pre-trained
 * dictionary, compatible with `stream.pipeline()` and pipe-based workflows.
 *
 * @param dict Pre-trained dictionary (from `zstdTrainDictionary`).
 * @param level Compression level (1-22, or negative for fast mode). Default is 3.
 */
export declare function createZstdCompressDictTransform(
  dict: Buffer | Uint8Array,
  level?: number,
): Transform;

/**
 * Create a Node.js stream.Transform for zstd decompression with a pre-trained dictionary.
 *
 * Uses Node.js `stream.Transform` to provide chunked decompression with a pre-trained
 * dictionary, compatible with `stream.pipeline()` and pipe-based workflows.
 *
 * @param dict Pre-trained dictionary (must match the one used for compression).
 */
export declare function createZstdDecompressDictTransform(
  dict: Buffer | Uint8Array,
  maxOutputSize?: number,
): Transform;

/**
 * Create a Node.js stream.Transform for auto-detect decompression.
 *
 * Detects the compression format (zstd, gzip, or brotli) from the first
 * few bytes and delegates to the appropriate decompression context.
 * Raw deflate is not supported (no magic bytes to distinguish it).
 *
 * @param maxOutputSize Maximum decompressed output size in bytes. Default is 256 MB.
 */
export declare function createDecompressTransform(maxOutputSize?: number): Transform;
