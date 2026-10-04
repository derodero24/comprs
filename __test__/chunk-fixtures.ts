/** The kinds of binary chunks that the Web streams accept. */
export type ChunkKind =
  | 'Uint8Array'
  | 'ArrayBuffer'
  | 'DataView'
  | 'Uint16Array'
  | 'SharedArrayBuffer';

/** A chunk of one of the kinds in {@link ChunkKind}. */
export type Chunk = ArrayBufferLike | ArrayBufferView;

/** Every chunk kind the runtime supports: SharedArrayBuffer may be missing. */
export const CHUNK_KINDS: ChunkKind[] = [
  'Uint8Array',
  'ArrayBuffer',
  'DataView',
  'Uint16Array',
  ...(typeof SharedArrayBuffer === 'undefined' ? [] : (['SharedArrayBuffer'] as const)),
];

/**
 * Copy `bytes` into a new ArrayBuffer, 2 bytes in and followed by 2 more
 * bytes, all of them 0xff, so that a view of them has a byteOffset and does
 * not cover its whole ArrayBuffer.
 */
function padded(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength + 4);
  const view = new Uint8Array(buffer);
  view.fill(0xff);
  view.set(bytes, 2);
  return buffer;
}

/**
 * `bytes` as chunks of `kind`. A Uint16Array covers an even number of bytes,
 * so an odd last byte follows it in a Uint8Array.
 */
function toChunk(bytes: Uint8Array, kind: ChunkKind): Chunk[] {
  const length = bytes.byteLength;
  switch (kind) {
    case 'Uint8Array':
      return [new Uint8Array(padded(bytes), 2, length)];
    case 'ArrayBuffer':
      return [padded(bytes).slice(2, 2 + length)];
    case 'DataView':
      return [new DataView(padded(bytes), 2, length)];
    case 'Uint16Array': {
      const even = length - (length % 2);
      const chunks: Chunk[] = [];
      if (even > 0) chunks.push(new Uint16Array(padded(bytes), 2, even / 2));
      if (even < length) chunks.push(bytes.slice(even));
      return chunks;
    }
    case 'SharedArrayBuffer': {
      const shared = new SharedArrayBuffer(length);
      new Uint8Array(shared).set(bytes);
      return [shared];
    }
  }
}

/** Split `data` into chunks of `kind` that hold `size` bytes each. */
export function toChunks(data: Uint8Array, size: number, kind: ChunkKind): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = 0; i < data.byteLength; i += size) {
    chunks.push(...toChunk(data.subarray(i, i + size), kind));
  }
  return chunks;
}

/** A ReadableStream of `chunks`. */
export function streamOf<T>(chunks: readonly T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Read every chunk from `stream`. */
export async function readChunks(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
