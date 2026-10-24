// An ES module consumer of @derodero24/comprs/next with the ECMAScript
// library alone: neither the DOM library nor the types of Node.js. It
// resolves the package like a bundler does, without the `browser`
// condition, and type-checks its dependencies' declarations
// (skipLibCheck: false), so the declarations of ./next must need neither.
// Its `signal` option takes an AbortSignalLike, which a minimal polyfill
// of AbortSignal satisfies. The stream classes declare their sides with the
// stream interfaces of the DOM library and of the types of Node.js, which
// ./next declares as empty ones where neither is loaded.
import type {
  AbortSignalLike,
  Bytes,
  CompressionStreamOptions,
  CompressOptions,
} from '@derodero24/comprs/next';
import {
  CompressionStream,
  compress,
  compressSync,
  DecompressionStream,
  Dictionary,
  decompress,
} from '@derodero24/comprs/next';

const input = Uint8Array.of(104, 101, 108, 108, 111);

/** A signal that never aborts, with only the members that ./next reads. */
const signal: AbortSignalLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const options: CompressOptions = { format: 'zstd' };
const compressed: Bytes = await compress(input, { ...options, signal });
const restored: Bytes = await decompress(compressed, { format: 'zstd', signal });

// Without the declarations of `Symbol.dispose`, close() frees a Dictionary.
const dictionary = Dictionary.from(input, { format: 'zstd' });
const withDictionary: Bytes = compressSync(input, { format: 'zstd', dictionary });
dictionary.close();

const streamOptions: CompressionStreamOptions = { level: 3 };
const sides = [
  new CompressionStream('zstd', streamOptions).readable,
  new DecompressionStream('auto').writable,
];

export { restored, sides, withDictionary };
