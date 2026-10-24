// The entry point of @derodero24/comprs/next/lz4 for browsers (#342): the
// functions of api.ts for the formats of the lz4 family alone, with the
// lz4 WebAssembly build as their backend, once ../wasm-lz4.js has loaded
// it with top-level await. The build leaves the other formats out, so it is
// a fraction of the size of the full one. It exports what the entry point
// for Node.js, lz4.ts, exports.
import * as glue from '../wasm-lz4.js';
import { CompressionStream as AnyCompressionStream, DecompressionStream as AnyDecompressionStream, compress as compressAny, compressSync as compressSyncAny, decompress as decompressAny, decompressSync as decompressSyncAny, FAMILY_FORMATS, } from './api.js';
import { registerBackend } from './backend.js';
import { wasmBackend } from './wasm.js';
registerBackend(wasmBackend(glue, FAMILY_FORMATS.lz4), FAMILY_FORMATS.lz4);
export { detectFormat } from './api.js';
/** {@link compressAny | compress}, for the formats of the lz4 family. */
export const compress = compressAny;
/** {@link compressSyncAny | compressSync}, for the formats of the lz4 family. */
export const compressSync = compressSyncAny;
/** {@link decompressAny | decompress}, for the formats of the lz4 family. */
export const decompress = decompressAny;
/** {@link decompressSyncAny | decompressSync}, for the formats of the lz4 family. */
export const decompressSync = decompressSyncAny;
/** {@link AnyCompressionStream | CompressionStream}, for the formats of the lz4 family. */
export const CompressionStream = AnyCompressionStream;
/** {@link AnyDecompressionStream | DecompressionStream}, for the formats of the lz4 family. */
export const DecompressionStream = AnyDecompressionStream;
