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

/**
 * Create a Node.js stream.Transform for zstd compression.
 *
 * @param {number} [level=3] Compression level (1-22, or negative for fast mode)
 * @returns {Transform}
 */
function createZstdCompressTransform(level) {
  const ctx = new ZstdCompressContext(level);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for zstd decompression.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createZstdDecompressTransform(maxOutputSize) {
  const ctx = new ZstdDecompressContext(maxOutputSize);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for gzip compression.
 *
 * @param {number} [level=6] Compression level (0-9)
 * @returns {Transform}
 */
function createGzipCompressTransform(level) {
  const ctx = new GzipCompressContext(level);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for gzip decompression.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createGzipDecompressTransform(maxOutputSize) {
  const ctx = new GzipDecompressContext(maxOutputSize);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for raw deflate compression.
 *
 * @param {number} [level=6] Compression level (0-9)
 * @returns {Transform}
 */
function createDeflateCompressTransform(level) {
  const ctx = new DeflateCompressContext(level);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for raw deflate decompression.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createDeflateDecompressTransform(maxOutputSize) {
  const ctx = new DeflateDecompressContext(maxOutputSize);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for brotli compression.
 *
 * @param {number} [quality=6] Compression quality (0-11)
 * @returns {Transform}
 */
function createBrotliCompressTransform(quality) {
  const ctx = new BrotliCompressContext(quality);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for brotli decompression.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createBrotliDecompressTransform(maxOutputSize) {
  const ctx = new BrotliDecompressContext(maxOutputSize);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for zstd compression with a pre-trained dictionary.
 *
 * @param {Buffer | Uint8Array} dict Pre-trained dictionary
 * @param {number} [level=3] Compression level (1-22, or negative for fast mode)
 * @returns {Transform}
 */
function createZstdCompressDictTransform(dict, level) {
  const ctx = new ZstdCompressDictContext(dict, level);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for zstd decompression with a pre-trained dictionary.
 *
 * @param {Buffer | Uint8Array} dict Pre-trained dictionary (must match the one used for compression)
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createZstdDecompressDictTransform(dict, maxOutputSize) {
  const ctx = new ZstdDecompressDictContext(dict, maxOutputSize);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for brotli compression with a custom dictionary.
 *
 * @param {Buffer | Uint8Array} dict Custom dictionary
 * @param {number} [quality=6] Compression quality (0-11)
 * @returns {Transform}
 */
function createBrotliCompressDictTransform(dict, quality) {
  const ctx = new BrotliCompressDictContext(dict, quality);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for brotli decompression with a custom dictionary.
 *
 * @param {Buffer | Uint8Array} dict Custom dictionary (must match the one used for compression)
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createBrotliDecompressDictTransform(dict, maxOutputSize) {
  const ctx = new BrotliDecompressDictContext(dict, maxOutputSize);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
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

function pushIfNonEmpty(stream, result) {
  if (result.byteLength > 0) stream.push(result);
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

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (ctx) {
          pushIfNonEmpty(this, ctx.transform(chunk));
          callback();
          return;
        }

        const copy = Buffer.from(chunk);
        buffered.push(copy);
        bufferedLength += copy.length;
        if (bufferedLength < detectAt) {
          callback();
          return;
        }

        const data = Buffer.concat(buffered, bufferedLength);
        const format = detectFormat(data);
        // More input may still reveal the format, as for the start of a
        // brotli stream or of a skippable frame.
        if (format === 'unknown' && bufferedLength < DETECT_LIMIT) {
          buffered = [data];
          detectAt = Math.min(2 * bufferedLength, DETECT_LIMIT);
          callback();
          return;
        }
        start(this, format, data);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        if (!ctx) {
          // The input ended before its format was detected. Empty input has
          // no detectable format and throws.
          const data = Buffer.concat(buffered, bufferedLength);
          start(this, detectFormat(data), data);
        }

        pushIfNonEmpty(this, ctx.flush());
        // LZ4 decodes everything in flush(); the other contexts verify in
        // finish() that the input contained the whole stream.
        if (!(ctx instanceof Lz4DecompressContext)) {
          pushIfNonEmpty(this, ctx.finish());
        }
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for LZ4 frame compression.
 *
 * @returns {Transform}
 */
function createLz4CompressTransform() {
  const ctx = new Lz4CompressContext();
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        const finished = ctx.finish();
        if (finished.byteLength > 0) this.push(finished);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a Node.js stream.Transform for LZ4 frame decompression.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {Transform}
 */
function createLz4DecompressTransform(maxOutputSize) {
  const ctx = new Lz4DecompressContext(maxOutputSize);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const result = ctx.transform(chunk);
        if (result.byteLength > 0) this.push(result);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        const flushed = ctx.flush();
        if (flushed.byteLength > 0) this.push(flushed);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
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
