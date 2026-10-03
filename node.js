const { Transform } = require('node:stream');
const {
  ZstdCompressContext,
  ZstdDecompressContext,
  ZstdCompressDictContext,
  ZstdDecompressDictContext,
  GzipCompressContext,
  GzipDecompressContext,
  DeflateCompressContext,
  DeflateDecompressContext,
  BrotliCompressContext,
  BrotliDecompressContext,
  BrotliCompressDictContext,
  BrotliDecompressDictContext,
  Lz4CompressContext,
  Lz4DecompressContext,
  detectFormat,
} = require('./index.js');

function pushIfNonEmpty(stream, result) {
  if (result.byteLength > 0) stream.push(result);
}

/**
 * Create a Transform from `transform` and `flush`, which call stream
 * contexts. `close` closes the contexts once the stream is destroyed, which
 * happens when it ends, fails or is destroyed early, and releases their
 * native memory right away instead of when the garbage collector gets to
 * them.
 *
 * @param {(stream: Transform, chunk: Buffer) => void} transform
 * @param {(stream: Transform) => void} flush
 * @param {() => void} close
 * @returns {Transform}
 */
function closingTransform(transform, flush, close) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        transform(this, chunk);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        flush(this);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    destroy(err, callback) {
      close();
      callback(err);
    },
  });
}

/**
 * Create a Transform that feeds its input through `ctx`.
 *
 * @param {{ transform(chunk: Buffer): Buffer, flush(): Buffer, finish(): Buffer, close(): void }} ctx
 * @returns {Transform}
 */
function contextTransform(ctx) {
  return closingTransform(
    (stream, chunk) => pushIfNonEmpty(stream, ctx.transform(chunk)),
    (stream) => {
      pushIfNonEmpty(stream, ctx.flush());
      pushIfNonEmpty(stream, ctx.finish());
    },
    () => ctx.close(),
  );
}

/**
 * Create a Node.js stream.Transform for zstd compression.
 *
 * @param {number} [level=3] Compression level (1-22, or negative for fast mode)
 * @returns {Transform}
 */
function createZstdCompressTransform(level) {
  return contextTransform(new ZstdCompressContext(level));
}

/**
 * Create a Node.js stream.Transform for zstd decompression.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createZstdDecompressTransform(maxOutputSize) {
  return contextTransform(new ZstdDecompressContext(maxOutputSize));
}

/**
 * Create a Node.js stream.Transform for gzip compression.
 *
 * @param {number} [level=6] Compression level (0-9)
 * @returns {Transform}
 */
function createGzipCompressTransform(level) {
  return contextTransform(new GzipCompressContext(level));
}

/**
 * Create a Node.js stream.Transform for gzip decompression.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createGzipDecompressTransform(maxOutputSize) {
  return contextTransform(new GzipDecompressContext(maxOutputSize));
}

/**
 * Create a Node.js stream.Transform for raw deflate compression.
 *
 * @param {number} [level=6] Compression level (0-9)
 * @returns {Transform}
 */
function createDeflateCompressTransform(level) {
  return contextTransform(new DeflateCompressContext(level));
}

/**
 * Create a Node.js stream.Transform for raw deflate decompression.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createDeflateDecompressTransform(maxOutputSize) {
  return contextTransform(new DeflateDecompressContext(maxOutputSize));
}

/**
 * Create a Node.js stream.Transform for brotli compression.
 *
 * @param {number} [quality=6] Compression quality (0-11)
 * @returns {Transform}
 */
function createBrotliCompressTransform(quality) {
  return contextTransform(new BrotliCompressContext(quality));
}

/**
 * Create a Node.js stream.Transform for brotli decompression.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createBrotliDecompressTransform(maxOutputSize) {
  return contextTransform(new BrotliDecompressContext(maxOutputSize));
}

/**
 * Create a Node.js stream.Transform for zstd compression with a pre-trained dictionary.
 *
 * @param {Buffer | Uint8Array} dict Pre-trained dictionary
 * @param {number} [level=3] Compression level (1-22, or negative for fast mode)
 * @returns {Transform}
 */
function createZstdCompressDictTransform(dict, level) {
  return contextTransform(new ZstdCompressDictContext(dict, level));
}

/**
 * Create a Node.js stream.Transform for zstd decompression with a pre-trained dictionary.
 *
 * @param {Buffer | Uint8Array} dict Pre-trained dictionary (must match the one used for compression)
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createZstdDecompressDictTransform(dict, maxOutputSize) {
  return contextTransform(new ZstdDecompressDictContext(dict, maxOutputSize));
}

/**
 * Create a Node.js stream.Transform for brotli compression with a custom dictionary.
 *
 * @param {Buffer | Uint8Array} dict Custom dictionary
 * @param {number} [quality=6] Compression quality (0-11)
 * @returns {Transform}
 */
function createBrotliCompressDictTransform(dict, quality) {
  return contextTransform(new BrotliCompressDictContext(dict, quality));
}

/**
 * Create a Node.js stream.Transform for brotli decompression with a custom dictionary.
 *
 * @param {Buffer | Uint8Array} dict Custom dictionary (must match the one used for compression)
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createBrotliDecompressDictTransform(dict, maxOutputSize) {
  return contextTransform(new BrotliDecompressDictContext(dict, maxOutputSize));
}

function createDecompressContext(format, maxOutputSize) {
  switch (format) {
    case 'zstd':
      return new ZstdDecompressContext(maxOutputSize);
    case 'gzip':
      return new GzipDecompressContext(maxOutputSize);
    case 'brotli':
      return new BrotliDecompressContext(maxOutputSize);
    case 'lz4':
      return new Lz4DecompressContext(maxOutputSize);
    default:
      throw new Error('unable to detect compression format from stream data');
  }
}

/**
 * How much input the auto-detecting transform waits for at most before it
 * decides on the format: detectFormat decodes up to the first 64 KiB to
 * recognize brotli.
 */
const DETECT_LIMIT = 64 * 1024;

/** The length of the zstd and LZ4 magic numbers, the longest ones. */
const MAGIC_LENGTH = 4;

/**
 * Create a Node.js stream.Transform for auto-detect decompression.
 *
 * Detects the compression format (zstd, gzip, brotli, or lz4) like
 * detectFormat and delegates to the appropriate decompression context.
 * Raw deflate is not supported (no magic bytes to distinguish it).
 *
 * The input is buffered until the format is detected: up to 64 KiB, or the
 * whole input if it is shorter. The transform emits an error if the format
 * is still unknown then.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createDecompressTransform(maxOutputSize) {
  let ctx = null;
  // The input received before the format is detected.
  let buffered = [];
  let bufferedLength = 0;
  // Detection runs once this much input has arrived, then each time the
  // input doubles, so that small chunks do not make it run on every chunk.
  let detectAt = MAGIC_LENGTH;

  function start(stream, format, data) {
    ctx = createDecompressContext(format, maxOutputSize);
    buffered = null;
    pushIfNonEmpty(stream, ctx.transform(data));
  }

  return closingTransform(
    (stream, chunk) => {
      if (ctx) {
        pushIfNonEmpty(stream, ctx.transform(chunk));
        return;
      }

      const copy = Buffer.from(chunk);
      buffered.push(copy);
      bufferedLength += copy.length;
      if (bufferedLength < detectAt) return;

      const data = Buffer.concat(buffered, bufferedLength);
      const format = detectFormat(data);
      // More input may still reveal the format, as for the start of a
      // brotli stream or of a skippable frame.
      if (format === 'unknown' && bufferedLength < DETECT_LIMIT) {
        buffered = [data];
        detectAt = Math.min(2 * bufferedLength, DETECT_LIMIT);
        return;
      }
      start(stream, format, data);
    },
    (stream) => {
      if (!ctx) {
        // The input ended before its format was detected. Empty input has
        // no detectable format and throws.
        const data = Buffer.concat(buffered, bufferedLength);
        start(stream, detectFormat(data), data);
      }

      pushIfNonEmpty(stream, ctx.flush());
      // finish() verifies that the input contained the whole stream.
      pushIfNonEmpty(stream, ctx.finish());
    },
    () => {
      ctx?.close();
      buffered = null;
    },
  );
}

/**
 * Create a Node.js stream.Transform for LZ4 frame compression.
 *
 * @returns {Transform}
 */
function createLz4CompressTransform() {
  return contextTransform(new Lz4CompressContext());
}

/**
 * Create a Node.js stream.Transform for LZ4 frame decompression.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createLz4DecompressTransform(maxOutputSize) {
  return contextTransform(new Lz4DecompressContext(maxOutputSize));
}

module.exports = {
  createZstdCompressTransform,
  createZstdDecompressTransform,
  createZstdCompressDictTransform,
  createZstdDecompressDictTransform,
  createGzipCompressTransform,
  createGzipDecompressTransform,
  createDeflateCompressTransform,
  createDeflateDecompressTransform,
  createBrotliCompressTransform,
  createBrotliDecompressTransform,
  createBrotliCompressDictTransform,
  createBrotliDecompressDictTransform,
  createLz4CompressTransform,
  createLz4DecompressTransform,
  createDecompressTransform,
};
