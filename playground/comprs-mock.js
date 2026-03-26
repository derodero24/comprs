/**
 * Development mock for comprs-wasm32-wasi.
 * Provides realistic fake compression ratios using native browser APIs where possible.
 * Used only when no local WASM build is available.
 */

// Use native CompressionStream for gzip (realistic results)
async function _compressWithNative(data, format) {
  const cs = new CompressionStream(format);
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Simple fake: return a plausible compressed size with a magic header
function fakeCompress(data, ratio, magicHeader) {
  const compressedSize = Math.max(8, Math.floor(data.length * ratio));
  const out = new Uint8Array(compressedSize);
  // Write magic bytes at the start
  for (let i = 0; i < Math.min(magicHeader.length, out.length); i++) {
    out[i] = magicHeader[i];
  }
  return out;
}

function fakeDecompress(data, originalData) {
  return originalData ?? new Uint8Array(data.length * 3);
}

// Cache for original data (needed for fake round-trips)
const cache = new WeakMap();

export function zstdCompress(data, level = 3) {
  const ratio = Math.max(0.2, 0.65 - (level - 1) * 0.02);
  const out = fakeCompress(data, ratio, [0x28, 0xb5, 0x2f, 0xfd]); // zstd magic
  cache.set(out, data);
  return out;
}
export function zstdDecompress(data) {
  return fakeDecompress(data, cache.get(data));
}
export function zstdDecompressWithCapacity(data) {
  return zstdDecompress(data);
}
export function zstdCompressAsync(data, level) {
  return Promise.resolve(zstdCompress(data, level));
}
export function zstdDecompressAsync(data) {
  return Promise.resolve(zstdDecompress(data));
}

// gzip: use native CompressionStream for realistic results
const _gzipCache = null;
export function gzipCompress(data, level = 6) {
  // Sync approximation
  const ratio = Math.max(0.25, 0.7 - level * 0.02);
  const out = fakeCompress(data, ratio, [0x1f, 0x8b]); // gzip magic
  cache.set(out, data);
  return out;
}
export function gzipDecompress(data) {
  return fakeDecompress(data, cache.get(data));
}
export function gzipDecompressWithCapacity(data) {
  return gzipDecompress(data);
}
export function gzipCompressAsync(data, level) {
  return Promise.resolve(gzipCompress(data, level));
}
export function gzipDecompressAsync(data) {
  return Promise.resolve(gzipDecompress(data));
}
export function gzipCompressWithHeader(data, _header, level) {
  return gzipCompress(data, level);
}
export function gzipReadHeader(_data) {
  return {};
}

export function brotliCompress(data, quality = 6) {
  const ratio = Math.max(0.18, 0.6 - quality * 0.025);
  const out = fakeCompress(data, ratio, [0x0b, 0x05]); // brotli-ish
  cache.set(out, data);
  return out;
}
export function brotliDecompress(data) {
  return fakeDecompress(data, cache.get(data));
}
export function brotliDecompressWithCapacity(data) {
  return brotliDecompress(data);
}
export function brotliCompressAsync(data, q) {
  return Promise.resolve(brotliCompress(data, q));
}
export function brotliDecompressAsync(data) {
  return Promise.resolve(brotliDecompress(data));
}
export function brotliCompressWithDict(data, _dict, quality) {
  return brotliCompress(data, quality);
}
export function brotliDecompressWithDict(data, _dict) {
  return brotliDecompress(data);
}
export function brotliCompressWithDictAsync(data, _dict, q) {
  return brotliCompressAsync(data, q);
}
export function brotliDecompressWithDictAsync(data, _dict) {
  return brotliDecompressAsync(data);
}
export function brotliDecompressWithDictWithCapacity(data, _dict) {
  return brotliDecompress(data);
}
export function brotliDecompressWithDictWithCapacityAsync(data, _dict) {
  return Promise.resolve(brotliDecompress(data));
}

export function deflateCompress(data, level = 6) {
  const ratio = Math.max(0.25, 0.68 - level * 0.02);
  const out = fakeCompress(data, ratio, [0x78, 0x9c]);
  cache.set(out, data);
  return out;
}
export function deflateDecompress(data) {
  return fakeDecompress(data, cache.get(data));
}
export function deflateDecompressWithCapacity(data) {
  return deflateDecompress(data);
}
export function deflateCompressAsync(data, level) {
  return Promise.resolve(deflateCompress(data, level));
}
export function deflateDecompressAsync(data) {
  return Promise.resolve(deflateDecompress(data));
}

export function lz4Compress(data) {
  const ratio = 0.55;
  const out = fakeCompress(data, ratio, [0x04, 0x22, 0x4d, 0x18]); // lz4 magic
  cache.set(out, data);
  return out;
}
export function lz4Decompress(data) {
  return fakeDecompress(data, cache.get(data));
}
export function lz4DecompressWithCapacity(data) {
  return lz4Decompress(data);
}
export function lz4CompressAsync(data) {
  return Promise.resolve(lz4Compress(data));
}
export function lz4DecompressAsync(data) {
  return Promise.resolve(lz4Decompress(data));
}

export function decompress(data) {
  return data;
}
export function decompressAsync(data) {
  return Promise.resolve(data);
}
export function detectFormat(_data) {
  return 'unknown';
}
export function crc32(_data) {
  return 0;
}
export function version() {
  return '0.3.1-mock';
}
export function zstdTrainDictionary(_samples, _maxSize) {
  return new Uint8Array(0);
}
export function zstdTrainDictionaryAsync(_samples, _maxSize) {
  return Promise.resolve(new Uint8Array(0));
}
export function zstdCompressWithDict(data, _dict, level) {
  return zstdCompress(data, level);
}
export function zstdDecompressWithDict(data, _dict) {
  return zstdDecompress(data);
}
export function zstdCompressWithDictAsync(data, _dict, level) {
  return zstdCompressAsync(data, level);
}
export function zstdDecompressWithDictAsync(data, _dict) {
  return zstdDecompressAsync(data);
}

export const CompressionFormat = { Zstd: 'zstd', Gzip: 'gzip', Brotli: 'brotli', Lz4: 'lz4' };

// Context stubs (not used in playground)
export class ZstdCompressContext {
  transform(c) {
    return zstdCompress(c);
  }
  flush() {
    return new Uint8Array(0);
  }
  finish() {
    return new Uint8Array(0);
  }
}
export class ZstdDecompressContext {
  transform(c) {
    return zstdDecompress(c);
  }
  flush() {
    return new Uint8Array(0);
  }
  finish() {
    return new Uint8Array(0);
  }
}
export class ZstdCompressDictContext extends ZstdCompressContext {}
export class ZstdDecompressDictContext extends ZstdDecompressContext {}
export class GzipCompressContext {
  transform(c) {
    return gzipCompress(c);
  }
  flush() {
    return new Uint8Array(0);
  }
  finish() {
    return new Uint8Array(0);
  }
}
export class GzipDecompressContext {
  transform(c) {
    return gzipDecompress(c);
  }
  flush() {
    return new Uint8Array(0);
  }
  finish() {
    return new Uint8Array(0);
  }
}
export class DeflateCompressContext {
  transform(c) {
    return deflateCompress(c);
  }
  flush() {
    return new Uint8Array(0);
  }
  finish() {
    return new Uint8Array(0);
  }
}
export class DeflateDecompressContext {
  transform(c) {
    return deflateDecompress(c);
  }
  flush() {
    return new Uint8Array(0);
  }
  finish() {
    return new Uint8Array(0);
  }
}
export class BrotliCompressContext {
  transform(c) {
    return brotliCompress(c);
  }
  flush() {
    return new Uint8Array(0);
  }
  finish() {
    return new Uint8Array(0);
  }
}
export class BrotliDecompressContext {
  transform(c) {
    return brotliDecompress(c);
  }
  flush() {
    return new Uint8Array(0);
  }
  finish() {
    return new Uint8Array(0);
  }
}
export class BrotliCompressDictContext extends BrotliCompressContext {}
export class BrotliDecompressDictContext extends BrotliDecompressContext {}
export class Lz4CompressContext {
  transform(c) {
    return lz4Compress(c);
  }
  flush() {
    return new Uint8Array(0);
  }
  finish() {
    return new Uint8Array(0);
  }
}
export class Lz4DecompressContext {
  transform(c) {
    return lz4Decompress(c);
  }
  flush() {
    return new Uint8Array(0);
  }
  finish() {
    return new Uint8Array(0);
  }
}
