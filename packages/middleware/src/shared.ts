import type { Encoding } from './types.js';

export const DEFAULT_THRESHOLD = 1024;
export const DEFAULT_ENCODINGS: readonly Encoding[] = ['zstd', 'br', 'gzip', 'deflate'];

/**
 * Check if a Content-Type is compressible. Returns false for missing Content-Type.
 *
 * `text/event-stream` is excluded, as in Hono's `compress()`: each Server-Sent
 * Event should reach the client as soon as it is written, so compressing the
 * stream would cost a flush per event.
 */
export function isCompressibleType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (ct === 'text/event-stream') return false;
  if (ct.startsWith('text/')) return true;
  if (ct === 'application/json') return true;
  if (ct === 'application/javascript') return true;
  if (ct === 'application/xml') return true;
  if (ct === 'application/xhtml+xml') return true;
  if (ct === 'application/rss+xml') return true;
  if (ct === 'application/atom+xml') return true;
  if (ct === 'application/graphql-response+json') return true;
  if (ct === 'image/svg+xml') return true;
  if (ct.endsWith('+json') || ct.endsWith('+xml')) return true;
  return false;
}

/**
 * Read a header value that may be a number or a list (as `getHeader()` returns
 * it) as one string, joining list values with `, `.
 */
export function headerValue(
  value: number | string | readonly string[] | undefined,
): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : value.join(', ');
}

/** Check whether a Cache-Control value contains the `no-transform` directive. */
export function hasNoTransform(cacheControl: string | undefined): boolean {
  if (!cacheControl) return false;
  return cacheControl
    .split(',')
    .some((directive) => directive.trim().toLowerCase() === 'no-transform');
}

/**
 * Check whether a response is a candidate for compression, whatever the
 * request: it has no Content-Encoding yet, allows transformation, passes the
 * user's filter and has a compressible type. Whether a candidate is
 * compressed depends on Accept-Encoding, so it varies on that field.
 *
 * @param header Reads a response header field by its lowercase name.
 * @param filter Runs the user's filter, if there is one.
 */
export function isCandidate(
  header: (name: string) => string | undefined,
  filter: () => boolean,
): boolean {
  if (header('content-encoding')) return false;
  if (hasNoTransform(header('cache-control'))) return false;
  if (!filter()) return false;
  return isCompressibleType(header('content-type'));
}

/** Check whether a response with this status can have content (not 1xx, 204 or 304). */
export function hasBody(statusCode: number): boolean {
  return statusCode >= 200 && statusCode !== 204 && statusCode !== 304;
}

/**
 * Check whether the content of a response may be compressed, judging by its
 * status and Content-Range. Besides responses without content, this rules
 * out ranges (206, or any response with a Content-Range), whose offsets count
 * the bytes of the uncompressed representation.
 */
export function canCompressBody(statusCode: number, hasContentRange: boolean): boolean {
  return hasBody(statusCode) && statusCode !== 206 && !hasContentRange;
}

/** Check whether a body of `length` bytes is worth compressing: not empty, and not below `threshold`. */
export function meetsThreshold(length: number, threshold: number): boolean {
  return length > 0 && length >= threshold;
}

/**
 * Turn the entity tag of a response that gets compressed into a weak one. A
 * strong tag stands for the exact bytes, so it has to differ between the
 * compressed and the uncompressed representation (RFC 9110, section
 * 8.8.3.3); a weak tag may be shared.
 */
export function weakenEtag(etag: string): string {
  return etag.startsWith('W/') ? etag : `W/${etag}`;
}

/**
 * Append Accept-Encoding to a Vary header value. Returns the new Vary value,
 * which is `current` itself when it already lists Accept-Encoding or `*`
 * (field names are compared whole and case-insensitively).
 */
export function appendVary(current: string | undefined): string {
  if (!current) return 'Accept-Encoding';
  const fields = current.split(',').map((field) => field.trim().toLowerCase());
  if (fields.includes('*') || fields.includes('accept-encoding')) return current;
  return `${current}, Accept-Encoding`;
}
