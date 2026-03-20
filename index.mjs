import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const binding = require('./index.js');
const streams = require('./streams.js');

export const {
  version,
  zstdCompress,
  zstdDecompress,
  zstdDecompressWithCapacity,
  ZstdCompressContext,
  ZstdDecompressContext,
  gzipCompress,
  gzipDecompress,
  deflateCompress,
  deflateDecompress,
  GzipCompressContext,
  GzipDecompressContext,
  DeflateCompressContext,
  DeflateDecompressContext,
} = binding;

export const {
  createZstdCompressStream,
  createZstdDecompressStream,
  createGzipCompressStream,
  createGzipDecompressStream,
  createDeflateCompressStream,
  createDeflateDecompressStream,
} = streams;
