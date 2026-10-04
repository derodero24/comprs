/**
 * Fake compressors for working on the playground UI without the WebAssembly
 * build of @derodero24/comprs. vite.config.js substitutes this module for the
 * package only when COMPRS_PLAYGROUND_MOCK=1 is set; the sizes are made up
 * from the level, and the output is not valid compressed data.
 */

function fakeCompress(data, ratio, magic) {
  const out = new Uint8Array(Math.max(magic.length, Math.floor(data.length * ratio)));
  out.set(magic);
  return out;
}

export function zstdCompress(data, level = 3) {
  return fakeCompress(data, Math.max(0.2, 0.65 - (level - 1) * 0.02), [0x28, 0xb5, 0x2f, 0xfd]);
}

export function gzipCompress(data, level = 6) {
  return fakeCompress(data, Math.max(0.25, 0.7 - level * 0.02), [0x1f, 0x8b]);
}

export function brotliCompress(data, quality = 6) {
  return fakeCompress(data, Math.max(0.18, 0.6 - quality * 0.025), [0x0b, 0x05]);
}

export function lz4Compress(data) {
  return fakeCompress(data, 0.55, [0x04, 0x22, 0x4d, 0x18]);
}
