// The entry point of @derodero24/comprs/next/brotli for browsers (#342): the
// functions of api.ts for the formats of the brotli family alone, with the
// brotli WebAssembly build as their backend, once ../wasm-brotli.js has loaded
// it with top-level await. The build leaves the other formats out, so it is
// a fraction of the size of the full one. It exports what the entry point
// for Node.js, brotli.ts, exports.
import * as glue from '../wasm-brotli.js';
import { CompressionStream as AnyCompressionStream, DecompressionStream as AnyDecompressionStream, compress as compressAny, compressSync as compressSyncAny, decompress as decompressAny, decompressSync as decompressSyncAny, FAMILY_FORMATS, } from './api.js';
import { registerBackend } from './backend.js';
import { wasmBackend } from './wasm.js';
registerBackend(wasmBackend(glue, FAMILY_FORMATS.brotli), FAMILY_FORMATS.brotli);
export { Dictionary, detectFormat } from './api.js';
/** {@link compressAny | compress}, for the formats of the brotli family. */
export const compress = compressAny;
/** {@link compressSyncAny | compressSync}, for the formats of the brotli family. */
export const compressSync = compressSyncAny;
/** {@link decompressAny | decompress}, for the formats of the brotli family. */
export const decompress = decompressAny;
/** {@link decompressSyncAny | decompressSync}, for the formats of the brotli family. */
export const decompressSync = decompressSyncAny;
/** {@link AnyCompressionStream | CompressionStream}, for the formats of the brotli family. */
export const CompressionStream = AnyCompressionStream;
/** {@link AnyDecompressionStream | DecompressionStream}, for the formats of the brotli family. */
export const DecompressionStream = AnyDecompressionStream;
