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
 * @returns {Transform}
 */
function createZstdDecompressTransform() {
  const ctx = new ZstdDecompressContext();
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
 * @returns {Transform}
 */
function createGzipDecompressTransform() {
  const ctx = new GzipDecompressContext();
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
 * @returns {Transform}
 */
function createDeflateDecompressTransform() {
  const ctx = new DeflateDecompressContext();
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
 * @returns {Transform}
 */
function createBrotliDecompressTransform() {
  const ctx = new BrotliDecompressContext();
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
 * @returns {Transform}
 */
function createZstdDecompressDictTransform(dict) {
  const ctx = new ZstdDecompressDictContext(dict);
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

function createDecompressContext(format) {
  switch (format) {
    case 'zstd':
      return new ZstdDecompressContext();
    case 'gzip':
      return new GzipDecompressContext();
    case 'brotli':
      return new BrotliDecompressContext();
    default:
      throw new Error('unable to detect compression format from stream data');
  }
}

function pushIfNonEmpty(stream, result) {
  if (result.byteLength > 0) stream.push(result);
}

/**
 * Create a Node.js stream.Transform for auto-detect decompression.
 *
 * Detects the compression format (zstd, gzip, or brotli) from the first
 * few bytes and delegates to the appropriate decompression context.
 * Raw deflate is not supported (no magic bytes to distinguish it).
 *
 * @returns {Transform}
 */
function createDecompressTransform() {
  let ctx = null;
  let buffer = null;

  function detectAndReplay(stream, data) {
    ctx = createDecompressContext(detectFormat(data));
    buffer = null;
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

        buffer = buffer === null ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);

        if (buffer.length < 4) {
          callback();
          return;
        }

        detectAndReplay(this, buffer);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        if (!ctx && buffer && buffer.length > 0) {
          detectAndReplay(this, buffer);
        }
        if (!ctx) {
          callback();
          return;
        }

        pushIfNonEmpty(this, ctx.flush());
        if (ctx instanceof GzipDecompressContext) {
          pushIfNonEmpty(this, ctx.finish());
        }
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
  createDecompressTransform,
};
