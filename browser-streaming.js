
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
  zstdCompress as _zstdCompress,
  zstdDecompress as _zstdDecompress,
  zstdDecompressWithCapacity as _zstdDecompressWithCapacity,
  zstdCompressWithDict as _zstdCompressWithDict,
  zstdDecompressWithDict as _zstdDecompressWithDict,
} from '@derodero24/zflate-wasm32-wasi'

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

// -- Gzip --

export class GzipCompressContext {
  constructor(level) {
    this._level = level
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('gzip stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('gzip stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('gzip stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _gzipCompress(data, this._level)
  }
}

export class GzipDecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('gzip stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('gzip stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('gzip stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _gzipDecompressWithCapacity(data, this._maxOutputSize)
    }
    return _gzipDecompress(data)
  }
}

// -- Deflate --

export class DeflateCompressContext {
  constructor(level) {
    this._level = level
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('deflate stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('deflate stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('deflate stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _deflateCompress(data, this._level)
  }
}

export class DeflateDecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('deflate stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('deflate stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('deflate stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _deflateDecompressWithCapacity(data, this._maxOutputSize)
    }
    return _deflateDecompress(data)
  }
}

// -- Brotli --

export class BrotliCompressContext {
  constructor(quality) {
    this._quality = quality
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('brotli stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('brotli stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('brotli stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _brotliCompress(data, this._quality)
  }
}

export class BrotliDecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('brotli stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('brotli stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _brotliDecompressWithCapacity(data, this._maxOutputSize)
    }
    return _brotliDecompress(data)
  }
}

// -- Zstd --

export class ZstdCompressContext {
  constructor(level) {
    this._level = level
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('zstd stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('zstd stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('zstd stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _zstdCompress(data, this._level)
  }
}

export class ZstdDecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('zstd stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('zstd stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _zstdDecompressWithCapacity(data, this._maxOutputSize)
    }
    return _zstdDecompress(data)
  }
}

// -- Zstd with dictionary --

export class ZstdCompressDictContext {
  constructor(dict, level) {
    this._dict = dict
    this._level = level
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('zstd stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('zstd stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('zstd stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _zstdCompressWithDict(data, this._dict, this._level)
  }
}

export class ZstdDecompressDictContext {
  constructor(dict, maxOutputSize) {
    this._dict = dict
    this._maxOutputSize = maxOutputSize
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('zstd stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('zstd stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _zstdDecompressWithDict(data, this._dict)
  }
}
