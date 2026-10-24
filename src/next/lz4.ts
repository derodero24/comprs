// The entry point of @derodero24/comprs/next/lz4 for Node.js (#342): the
// functions of api.ts for the formats of the lz4 family alone, with the
// native addon as their backend for those formats, as the browser entry
// point of the family, browser-lz4.ts, has the lz4 WebAssembly build.
// The other formats fail with ERR_COMPRS_INVALID_ARG unless another entry
// point registered them, so code behaves in Node.js as in browsers. The
// names are exported one by one, as index.ts exports them.
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
import { native } from './native.js';

registerBackend(native, FAMILY_FORMATS.lz4);

/** The formats of the lz4 family. */
type Formats = 'lz4';

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

/** {@link compressAny | compress}, for the formats of the lz4 family. */
export const compress: (
  data: Input,
  options: CompressOptions<Formats> & AbortOptions,
) => Promise<Bytes> = compressAny;

/** {@link compressSyncAny | compressSync}, for the formats of the lz4 family. */
export const compressSync: (data: Input, options: CompressOptions<Formats>) => Bytes =
  compressSyncAny;

/** {@link decompressAny | decompress}, for the formats of the lz4 family. */
export const decompress: (
  data: Input,
  options?: DecompressOptions<Formats> & AbortOptions,
) => Promise<Bytes> = decompressAny;

/** {@link decompressSyncAny | decompressSync}, for the formats of the lz4 family. */
export const decompressSync: (data: Input, options?: DecompressOptions<Formats>) => Bytes =
  decompressSyncAny;

/** {@link AnyCompressionStream | CompressionStream}, for the formats of the lz4 family. */
export const CompressionStream: new (
  format: Formats,
  options?: CompressionStreamOptions,
) => AnyCompressionStream = AnyCompressionStream;
export type CompressionStream = AnyCompressionStream;

/** {@link AnyDecompressionStream | DecompressionStream}, for the formats of the lz4 family. */
export const DecompressionStream: new (
  format: Formats | 'auto',
  options?: DecompressionStreamOptions,
) => AnyDecompressionStream = AnyDecompressionStream;
export type DecompressionStream = AnyDecompressionStream;
