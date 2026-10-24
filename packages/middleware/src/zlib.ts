// The `deflate` content coding is the zlib format (RFC 1950) around DEFLATE
// data (RFC 9110, section 8.4.1.2). comprs compresses to raw DEFLATE, so the
// zlib header and the Adler-32 trailer are added here.

/** The Adler-32 checksum of no data, to start from. */
export const ADLER32_INITIAL = 1;

/** The largest prime below 2^16, the modulus of both Adler-32 sums. */
const ADLER32_MODULUS = 65521;

/** Bytes to sum before reducing, small enough to keep the sums below 2^32 (as zlib's NMAX). */
const ADLER32_BLOCK = 5552;

/**
 * Update an Adler-32 checksum (RFC 1950, section 8.2) with `data`, starting
 * from ADLER32_INITIAL. Feeding data in pieces gives the checksum of the
 * whole.
 */
export function adler32(data: Uint8Array, checksum: number): number {
  let a = checksum & 0xffff;
  let b = checksum >>> 16;
  for (let start = 0; start < data.length; start += ADLER32_BLOCK) {
    const end = Math.min(start + ADLER32_BLOCK, data.length);
    for (let i = start; i < end; i++) {
      a += data[i] ?? 0;
      b += a;
    }
    a %= ADLER32_MODULUS;
    b %= ADLER32_MODULUS;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * The two-byte zlib header: deflate with a 32 KiB window (CMF 0x78), and the
 * level class zlib records for the compression level (FLEVEL), which is
 * informational only. FCHECK makes the header a multiple of 31.
 */
export function zlibHeader(level = 6): Uint8Array {
  const cmf = 0x78;
  const levelClass = level < 2 ? 0 : level < 6 ? 1 : level === 6 ? 2 : 3;
  const flags = levelClass << 6;
  return Uint8Array.of(cmf, flags + 31 - (((cmf << 8) | flags) % 31));
}

/** The zlib trailer: the Adler-32 checksum of the uncompressed data, big-endian. */
export function zlibTrailer(checksum: number): Uint8Array {
  return Uint8Array.of(
    checksum >>> 24,
    (checksum >>> 16) & 0xff,
    (checksum >>> 8) & 0xff,
    checksum & 0xff,
  );
}

/** Wrap the raw DEFLATE data compressed from `input` at `level` in the zlib format. */
export function toZlib(deflated: Uint8Array, input: Uint8Array, level?: number): Uint8Array {
  const output = new Uint8Array(2 + deflated.length + 4);
  output.set(zlibHeader(level), 0);
  output.set(deflated, 2);
  output.set(zlibTrailer(adler32(input, ADLER32_INITIAL)), 2 + deflated.length);
  return output;
}
