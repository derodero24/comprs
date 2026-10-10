import {
  constants,
  brotliCompressSync as nodeBrotliCompress,
  brotliDecompressSync as nodeBrotliDecompress,
} from 'node:zlib';
import { brotliCompress, brotliDecompress } from '../index.js';
import {
  type BenchInput,
  compareLibraries,
  JSON_DATA,
  type Library,
  MEDIUM,
} from './bench-fixtures.js';

// comprs always uses a window of 2^22 bytes, node:zlib's default; brotliCompress
// takes no lgwin. node:zlib's default quality is 11, comprs's is 6, so both
// are passed explicitly (#563).
const LGWIN = 22;

const libraries = (quality: number): Library[] => [
  {
    name: 'comprs',
    compress: (data) => brotliCompress(data, quality),
    decompress: (data) => brotliDecompress(data),
  },
  {
    name: 'node:zlib',
    compress: (data) =>
      nodeBrotliCompress(data, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: quality,
          [constants.BROTLI_PARAM_LGWIN]: LGWIN,
        },
      }),
    decompress: (data) => nodeBrotliDecompress(data),
  },
];

// Quality 11 is slow, so it runs on two inputs only.
const Q11_INPUTS: readonly BenchInput[] = [
  { label: 'JSON 84KB', data: JSON_DATA },
  { label: 'patterned 10KB', data: MEDIUM },
];

compareLibraries('brotli', `quality 6, lgwin ${LGWIN}`, libraries(6));
compareLibraries('brotli', `quality 11, lgwin ${LGWIN}`, libraries(11), { inputs: Q11_INPUTS });
