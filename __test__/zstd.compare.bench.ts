import * as zlib from 'node:zlib';
import { zstdCompress, zstdDecompress } from '../index.js';
import { compareLibraries, type Library } from './bench-fixtures.js';

// The default level of both libraries, passed explicitly.
const LEVEL = 3;

// node:zlib has no zstd before Node.js 22.15: comprs then runs alone.
const HAS_NODE_ZSTD = typeof zlib.zstdCompressSync === 'function';

const nodeZlib: Library = {
  name: 'node:zlib',
  compress: (data) =>
    zlib.zstdCompressSync(data, { params: { [zlib.constants.ZSTD_c_compressionLevel]: LEVEL } }),
  decompress: (data) => zlib.zstdDecompressSync(data),
};

compareLibraries('zstd', `level ${LEVEL}`, [
  {
    name: 'comprs',
    compress: (data) => zstdCompress(data, LEVEL),
    decompress: (data) => zstdDecompress(data),
  },
  ...(HAS_NODE_ZSTD ? [nodeZlib] : []),
]);
