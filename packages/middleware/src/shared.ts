export const DEFAULT_THRESHOLD = 1024;
export const DEFAULT_ENCODINGS = ['zstd', 'br', 'gzip', 'deflate'] as const;

/** Check if a Content-Type is compressible. Returns false for missing Content-Type. */
export function isCompressibleType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
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

/** Append Accept-Encoding to a Vary header value. Returns the new Vary value. */
export function appendVary(current: string | undefined): string {
  if (!current) return 'Accept-Encoding';
  if (current.toLowerCase().includes('accept-encoding')) return current;
  return `${current}, Accept-Encoding`;
}
