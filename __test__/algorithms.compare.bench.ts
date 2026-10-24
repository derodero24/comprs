import {
  brotliCompress,
  brotliDecompress,
  gzipCompress,
  gzipDecompress,
  lz4Compress,
  lz4Decompress,
  zstdCompress,
  zstdDecompress,
} from '../index.js';
import { compareLibraries } from './bench-fixtures.js';

// The formats of comprs, each at its default level: zstd 3, gzip 6 and
// brotli quality 6 (lz4 has no levels). Each decompresses its own output.
compareLibraries(
  'comprs',
  'default levels',
  [
    {
      name: 'zstd',
      compress: (data) => zstdCompress(data),
      decompress: (data) => zstdDecompress(data),
    },
    {
      name: 'gzip',
      compress: (data) => gzipCompress(data),
      decompress: (data) => gzipDecompress(data),
    },
    {
      name: 'brotli',
      compress: (data) => brotliCompress(data),
      decompress: (data) => brotliDecompress(data),
    },
    {
      name: 'lz4',
      compress: (data) => lz4Compress(data),
      decompress: (data) => lz4Decompress(data),
    },
  ],
  { ownOutput: true },
);
