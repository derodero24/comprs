
import {
  gzipCompress as _gzipCompress,
  gzipDecompress as _gzipDecompress,
  gzipDecompressWithCapacity as _gzipDecompressWithCapacity,
  deflateCompress as _deflateCompress,
  deflateDecompress as _deflateDecompress,
  deflateDecompressWithCapacity as _deflateDecompressWithCapacity,
  brotliCompress as _brotliCompress,
  brotliDecompress as _brotliDecompress,
  brotliDecompressWithCapacity as _brotliDecompressWithCapacity,
  brotliCompressWithDict as _brotliCompressWithDict,
  brotliDecompressWithDict as _brotliDecompressWithDict,
  brotliDecompressWithDictWithCapacity as _brotliDecompressWithDictWithCapacity,
  lz4Compress as _lz4Compress,
  lz4Decompress as _lz4Decompress,
  lz4DecompressWithCapacity as _lz4DecompressWithCapacity,
  zstdCompress as _zstdCompress,
  zstdDecompress as _zstdDecompress,
  zstdDecompressWithCapacity as _zstdDecompressWithCapacity,
  zstdCompressWithDict as _zstdCompressWithDict,
  zstdDecompressWithDict as _zstdDecompressWithDict,
  zstdDecompressWithDictWithCapacity as _zstdDecompressWithDictWithCapacity,
} from './comprs-wasm.js'

/**
 * Concatenate an array of Uint8Array chunks into a single Uint8Array.
 */
function concatChunks(chunks) {
  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength), offset)
    offset += chunk.byteLength
  }
  return result
}

/**
 * Base of the adapters, which buffer their input in `_chunks` until the
 * stream ends.
 */
class ContextAdapter {
  constructor() {
    this._chunks = []
    // 'open', 'finished' once the stream has ended, or 'closed'. The
    // decompression adapters decode in flush(), which leaves them 'decoded'.
    this._state = 'open'
  }

  /**
   * Drop the buffered input, as `close()` releases the state of a native
   * context. Later calls throw; closing a finished or closed context does
   * nothing. `[Symbol.dispose]()` is the same method, for `using`
   * declarations.
   */
  close() {
    if (this._state === 'finished') return
    this._chunks = []
    this._state = 'closed'
  }

  /** Throw if the context is closed, or if `ended`. */
  _checkOpen(name, ended) {
    if (this._state === 'closed') throw new Error(`${name} already closed`)
    if (ended) throw new Error(`${name} already finished`)
  }
}

if (Symbol.dispose) ContextAdapter.prototype[Symbol.dispose] = ContextAdapter.prototype.close

// -- Gzip --

export class GzipCompressContext extends ContextAdapter {
  constructor(level) {
    super()
    this._level = level
  }

  transform(chunk) {
    this._checkOpen('gzip stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('gzip stream', this._state !== 'open')
    return new Uint8Array(0)
  }

  finish() {
    this._checkOpen('gzip stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _gzipCompress(data, this._level)
  }
}

export class GzipDecompressContext extends ContextAdapter {
  constructor(maxOutputSize) {
    super()
    this._maxOutputSize = maxOutputSize
  }

  transform(chunk) {
    this._checkOpen('gzip stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('gzip stream', this._state !== 'open')
    return new Uint8Array(0)
  }

  finish() {
    this._checkOpen('gzip stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _gzipDecompressWithCapacity(data, this._maxOutputSize)
    }
    return _gzipDecompress(data)
  }
}

// -- Deflate --

export class DeflateCompressContext extends ContextAdapter {
  constructor(level) {
    super()
    this._level = level
  }

  transform(chunk) {
    this._checkOpen('deflate stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('deflate stream', this._state !== 'open')
    return new Uint8Array(0)
  }

  finish() {
    this._checkOpen('deflate stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _deflateCompress(data, this._level)
  }
}

export class DeflateDecompressContext extends ContextAdapter {
  constructor(maxOutputSize) {
    super()
    this._maxOutputSize = maxOutputSize
  }

  transform(chunk) {
    this._checkOpen('deflate stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('deflate stream', this._state !== 'open')
    return new Uint8Array(0)
  }

  finish() {
    this._checkOpen('deflate stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _deflateDecompressWithCapacity(data, this._maxOutputSize)
    }
    return _deflateDecompress(data)
  }
}

// -- Brotli --

export class BrotliCompressContext extends ContextAdapter {
  constructor(quality) {
    super()
    this._quality = quality
  }

  transform(chunk) {
    this._checkOpen('brotli stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('brotli stream', this._state !== 'open')
    return new Uint8Array(0)
  }

  finish() {
    this._checkOpen('brotli stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _brotliCompress(data, this._quality)
  }
}

export class BrotliDecompressContext extends ContextAdapter {
  constructor(maxOutputSize) {
    super()
    this._maxOutputSize = maxOutputSize
  }

  transform(chunk) {
    this._checkOpen('brotli stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('brotli stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    const result =
      this._maxOutputSize != null
        ? _brotliDecompressWithCapacity(data, this._maxOutputSize)
        : _brotliDecompress(data)
    this._state = 'decoded'
    return result
  }

  finish() {
    // flush() decodes and verifies the whole stream, so nothing is left after it.
    const result = this._state === 'open' ? this.flush() : new Uint8Array(0)
    this._checkOpen('brotli stream', this._state !== 'decoded')
    this._state = 'finished'
    return result
  }
}

// -- Brotli with dictionary --

export class BrotliCompressDictContext extends ContextAdapter {
  constructor(dict, quality) {
    super()
    this._dict = dict
    this._quality = quality
  }

  transform(chunk) {
    this._checkOpen('brotli dict stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('brotli dict stream', this._state !== 'open')
    return new Uint8Array(0)
  }

  finish() {
    this._checkOpen('brotli dict stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _brotliCompressWithDict(data, this._dict, this._quality)
  }
}

export class BrotliDecompressDictContext extends ContextAdapter {
  constructor(dict, maxOutputSize) {
    super()
    this._dict = dict
    this._maxOutputSize = maxOutputSize
  }

  transform(chunk) {
    this._checkOpen('brotli dict stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('brotli dict stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    const result =
      this._maxOutputSize != null
        ? _brotliDecompressWithDictWithCapacity(data, this._dict, this._maxOutputSize)
        : _brotliDecompressWithDict(data, this._dict)
    this._state = 'decoded'
    return result
  }

  finish() {
    // flush() decodes and verifies the whole stream, so nothing is left after it.
    const result = this._state === 'open' ? this.flush() : new Uint8Array(0)
    this._checkOpen('brotli dict stream', this._state !== 'decoded')
    this._state = 'finished'
    return result
  }
}

// -- LZ4 --

export class Lz4CompressContext extends ContextAdapter {
  constructor() {
    super()
  }

  transform(chunk) {
    this._checkOpen('lz4 stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('lz4 stream', this._state !== 'open')
    return new Uint8Array(0)
  }

  finish() {
    this._checkOpen('lz4 stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _lz4Compress(data)
  }
}

export class Lz4DecompressContext extends ContextAdapter {
  constructor(maxOutputSize) {
    super()
    this._maxOutputSize = maxOutputSize
  }

  transform(chunk) {
    this._checkOpen('lz4 stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('lz4 stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    const result =
      this._maxOutputSize != null
        ? _lz4DecompressWithCapacity(data, this._maxOutputSize)
        : _lz4Decompress(data)
    this._state = 'decoded'
    return result
  }

  finish() {
    // flush() decodes the whole input, so nothing is left after it.
    const result = this._state === 'open' ? this.flush() : new Uint8Array(0)
    this._checkOpen('lz4 stream', this._state !== 'decoded')
    this._state = 'finished'
    return result
  }
}

// -- Zstd --

export class ZstdCompressContext extends ContextAdapter {
  constructor(level) {
    super()
    this._level = level
  }

  transform(chunk) {
    this._checkOpen('zstd stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('zstd stream', this._state !== 'open')
    return new Uint8Array(0)
  }

  finish() {
    this._checkOpen('zstd stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _zstdCompress(data, this._level)
  }
}

export class ZstdDecompressContext extends ContextAdapter {
  constructor(maxOutputSize) {
    super()
    this._maxOutputSize = maxOutputSize
  }

  transform(chunk) {
    this._checkOpen('zstd stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('zstd stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    const result =
      this._maxOutputSize != null
        ? _zstdDecompressWithCapacity(data, this._maxOutputSize)
        : _zstdDecompress(data)
    this._state = 'decoded'
    return result
  }

  finish() {
    // flush() decodes and verifies the whole stream, so nothing is left after it.
    const result = this._state === 'open' ? this.flush() : new Uint8Array(0)
    this._checkOpen('zstd stream', this._state !== 'decoded')
    this._state = 'finished'
    return result
  }
}

// -- Zstd with dictionary --

export class ZstdCompressDictContext extends ContextAdapter {
  constructor(dict, level) {
    super()
    this._dict = dict
    this._level = level
  }

  transform(chunk) {
    this._checkOpen('zstd stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('zstd stream', this._state !== 'open')
    return new Uint8Array(0)
  }

  finish() {
    this._checkOpen('zstd stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _zstdCompressWithDict(data, this._dict, this._level)
  }
}

export class ZstdDecompressDictContext extends ContextAdapter {
  constructor(dict, maxOutputSize) {
    super()
    this._dict = dict
    this._maxOutputSize = maxOutputSize
  }

  transform(chunk) {
    this._checkOpen('zstd stream', this._state !== 'open')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    this._checkOpen('zstd stream', this._state !== 'open')
    this._state = 'finished'
    const data = concatChunks(this._chunks)
    this._chunks = []
    const result =
      this._maxOutputSize != null
        ? _zstdDecompressWithDictWithCapacity(data, this._dict, this._maxOutputSize)
        : _zstdDecompressWithDict(data, this._dict)
    this._state = 'decoded'
    return result
  }

  finish() {
    // flush() decodes and verifies the whole stream, so nothing is left after it.
    const result = this._state === 'open' ? this.flush() : new Uint8Array(0)
    this._checkOpen('zstd stream', this._state !== 'decoded')
    this._state = 'finished'
    return result
  }
}
