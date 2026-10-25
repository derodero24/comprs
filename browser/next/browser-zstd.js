// The entry point of @derodero24/comprs/next/zstd for browsers (#342): the
// functions of api.ts for the formats of the zstd family alone, with the
// zstd WebAssembly build as their backend, once ../wasm-zstd.js has loaded
// it with top-level await. The build leaves the other formats out, so it is
// a fraction of the size of the full one. It exports what the entry point
// for Node.js, zstd.ts, exports.
import * as glue from '../wasm-zstd.js';
import { CompressionStream as AnyCompressionStream, DecompressionStream as AnyDecompressionStream, compress as compressAny, compressSync as compressSyncAny, decompress as decompressAny, decompressSync as decompressSyncAny, FAMILY_FORMATS, } from './api.js';
import { registerBackend } from './backend.js';
import { wasmBackend } from './wasm.js';
registerBackend(wasmBackend(glue, FAMILY_FORMATS.zstd), FAMILY_FORMATS.zstd);
export { Dictionary, detectFormat, trainDictionary, trainDictionarySync } from './api.js';
/** {@link compressAny | compress}, for the formats of the zstd family. */
export const compress = compressAny;
/** {@link compressSyncAny | compressSync}, for the formats of the zstd family. */
export const compressSync = compressSyncAny;
/** {@link decompressAny | decompress}, for the formats of the zstd family. */
export const decompress = decompressAny;
/** {@link decompressSyncAny | decompressSync}, for the formats of the zstd family. */
export const decompressSync = decompressSyncAny;
/** {@link AnyCompressionStream | CompressionStream}, for the formats of the zstd family. */
export const CompressionStream = AnyCompressionStream;
/** {@link AnyDecompressionStream | DecompressionStream}, for the formats of the zstd family. */
export const DecompressionStream = AnyDecompressionStream;
