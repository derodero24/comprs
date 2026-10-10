// An ES module consumer of @derodero24/comprs/next with the DOM library and
// no Node.js types, which resolves the package like a bundler does, without
// the `browser` condition, so that it gets the declarations of the native
// build. It has strict settings, and its dependencies' declarations are
// type-checked (skipLibCheck: false). scripts/check-consumer-types.mjs
// installs the packed package next to it and runs tsc.
//
// The results of ./next are Uint8Arrays over an ArrayBuffer, which the DOM
// typings of TypeScript 5.7 and later take as a BlobPart or a BufferSource,
// unlike a Buffer, which the root entry returns, or a Uint8Array over any
// ArrayBufferLike (#577).
import type {
  AbortOptions,
  Bytes,
  CompressOptions,
  DictionaryOptions,
  ErrorCode,
  Format,
} from '@derodero24/comprs/next';
import {
  compress,
  compressSync,
  Dictionary,
  decompress,
  detectFormat,
} from '@derodero24/comprs/next';

const input = new TextEncoder().encode('hello');

const blob = new Blob([compressSync(input, { format: 'zstd' })]);
const digest: ArrayBuffer = await crypto.subtle.digest(
  'SHA-256',
  await compress(input, { format: 'gzip' }),
);

// The options take `undefined` for an optional property under
// exactOptionalPropertyTypes.
const options: CompressOptions = { format: 'deflate', level: undefined, dictionary: undefined };
const zlib: Bytes = compressSync(input, options);
const restored: Uint8Array<ArrayBuffer> = await decompress(zlib, { format: 'auto' });
const format: Format | undefined = detectFormat(zlib);

// The async functions take an AbortSignal of the DOM library.
const abortOptions: AbortOptions = { signal: new AbortController().signal };
const abortable: Bytes = await decompress(zlib, { ...abortOptions, format: 'deflate' });

// The declarations of Dictionary type-check without those of
// `Symbol.dispose`, which the DOM library and ES2023 lack: it then declares
// no [Symbol.dispose]() method, and close() frees it.
const dictionaryOptions: DictionaryOptions = { format: 'zstd', level: undefined };
const dictionary = Dictionary.from(input, dictionaryOptions);
const withDictionary: Bytes = compressSync(input, { format: 'zstd', dictionary });
const dictionaryBytes: Uint8Array<ArrayBuffer> = dictionary.toBytes();
dictionary.close();

const SIZE_LIMIT: ErrorCode = 'ERR_COMPRS_SIZE_LIMIT';

/** Whether `error` is an error of ./next whose output exceeded the limit. */
function isSizeLimit(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === SIZE_LIMIT;
}

export { abortable, blob, dictionaryBytes, digest, format, isSizeLimit, restored, withDictionary };
