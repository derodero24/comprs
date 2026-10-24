// The entry point of @derodero24/comprs/next/gzip for browsers (#342): the
// functions of api.ts for the formats of the gzip family alone, with the
// gzip WebAssembly build as their backend, once ../wasm-gzip.js has loaded
// it with top-level await. The build leaves the other formats out, so it is
// a fraction of the size of the full one. It exports what the entry point
// for Node.js, gzip.ts, exports.
import * as glue from '../wasm-gzip.js';
import {
  type AbortOptions,
  CompressionStream as AnyCompressionStream,
  DecompressionStream as AnyDecompressionStream,
  type Bytes,
  type CompressionStreamOptions,
  type CompressOptions,
  compress as compressAny,
  compressSync as compressSyncAny,
  type DecompressionStreamOptions,
  type DecompressOptions,
  decompress as decompressAny,
  decompressSync as decompressSyncAny,
  FAMILY_FORMATS,
  type Input,
} from './api.js';
import { registerBackend } from './backend.js';
import { wasmBackend } from './wasm.js';

registerBackend(wasmBackend(glue, FAMILY_FORMATS.gzip), FAMILY_FORMATS.gzip);

/** The formats of the gzip family. */
type Formats = 'gzip' | 'deflate' | 'deflate-raw';

export type {
  AbortOptions,
  AbortSignalLike,
  Bytes,
  CompressionStreamOptions,
  CompressOptions,
  DecompressionStreamOptions,
  DecompressOptions,
  DictionaryOptions,
  ErrorCode,
  Format,
  GzipHeaderOptions,
  Input,
  TrainDictionaryOptions,
} from './api.js';
export { detectFormat } from './api.js';

/** {@link compressAny | compress}, for the formats of the gzip family. */
export const compress: (
  data: Input,
  options: CompressOptions<Formats> & AbortOptions,
) => Promise<Bytes> = compressAny;

/** {@link compressSyncAny | compressSync}, for the formats of the gzip family. */
export const compressSync: (data: Input, options: CompressOptions<Formats>) => Bytes =
  compressSyncAny;

/** {@link decompressAny | decompress}, for the formats of the gzip family. */
export const decompress: (
  data: Input,
  options?: DecompressOptions<Formats> & AbortOptions,
) => Promise<Bytes> = decompressAny;

/** {@link decompressSyncAny | decompressSync}, for the formats of the gzip family. */
export const decompressSync: (data: Input, options?: DecompressOptions<Formats>) => Bytes =
  decompressSyncAny;

/** {@link AnyCompressionStream | CompressionStream}, for the formats of the gzip family. */
export const CompressionStream: new (
  format: Formats,
  options?: CompressionStreamOptions,
) => AnyCompressionStream = AnyCompressionStream;
export type CompressionStream = AnyCompressionStream;

/** {@link AnyDecompressionStream | DecompressionStream}, for the formats of the gzip family. */
export const DecompressionStream: new (
  format: Formats | 'auto',
  options?: DecompressionStreamOptions,
) => AnyDecompressionStream = AnyDecompressionStream;
export type DecompressionStream = AnyDecompressionStream;
