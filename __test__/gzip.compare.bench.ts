import { gunzipSync as nodeGunzip, gzipSync as nodeGzip } from 'node:zlib';
import * as fflate from 'fflate';
import * as pako from 'pako';
import { gzipCompress, gzipDecompress } from '../index.js';
import { compareLibraries } from './bench-fixtures.js';

// The default level of every library, passed explicitly.
const LEVEL = 6;

compareLibraries('gzip', `level ${LEVEL}`, [
  {
    name: 'comprs',
    compress: (data) => gzipCompress(data, LEVEL),
    decompress: (data) => gzipDecompress(data),
  },
  {
    name: 'pako',
    compress: (data) => pako.gzip(data, { level: LEVEL }),
    decompress: (data) => pako.ungzip(data),
  },
  {
    name: 'fflate',
    compress: (data) => fflate.gzipSync(data, { level: LEVEL }),
    decompress: (data) => fflate.gunzipSync(data),
  },
  {
    name: 'node:zlib',
    compress: (data) => nodeGzip(data, { level: LEVEL }),
    decompress: (data) => nodeGunzip(data),
  },
]);
