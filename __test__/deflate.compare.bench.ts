import { deflateRawSync as nodeDeflate, inflateRawSync as nodeInflate } from 'node:zlib';
import * as fflate from 'fflate';
import * as pako from 'pako';
import { deflateCompress, deflateDecompress } from '../index.js';
import { compareLibraries } from './bench-fixtures.js';

// The default level of every library, passed explicitly.
const LEVEL = 6;

compareLibraries('deflate', `level ${LEVEL}`, [
  {
    name: 'comprs',
    compress: (data) => deflateCompress(data, LEVEL),
    decompress: (data) => deflateDecompress(data),
  },
  {
    name: 'pako',
    compress: (data) => pako.deflateRaw(data, { level: LEVEL }),
    decompress: (data) => pako.inflateRaw(data),
  },
  {
    name: 'fflate',
    compress: (data) => fflate.deflateSync(data, { level: LEVEL }),
    decompress: (data) => fflate.inflateSync(data),
  },
  {
    name: 'node:zlib',
    compress: (data) => nodeDeflate(data, { level: LEVEL }),
    decompress: (data) => nodeInflate(data),
  },
]);
