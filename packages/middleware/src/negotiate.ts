import type { Encoding } from './types.js';

interface ParsedEncoding {
  name: string;
  quality: number;
}

const DEFAULT_ENCODINGS: Encoding[] = ['zstd', 'br', 'gzip', 'deflate'];

/**
 * Parse an Accept-Encoding header value into sorted encoding entries.
 */
function parseAcceptEncoding(header: string): ParsedEncoding[] {
  const entries: ParsedEncoding[] = [];

  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;

    const segments = trimmed.split(';');
    const encodingName = (segments[0] ?? '').trim().toLowerCase();

    let quality = 1.0;
    for (const param of segments.slice(1)) {
      const match = param.trim().match(/^q=(\d+(?:\.\d+)?)$/);
      if (match?.[1]) {
        quality = Number.parseFloat(match[1]);
        break;
      }
    }

    entries.push({ name: encodingName, quality });
  }

  // Sort by quality descending (stable sort preserves insertion order for equal quality)
  entries.sort((a, b) => b.quality - a.quality);
  return entries;
}

/**
 * Build the set of encodings the client accepts from parsed Accept-Encoding entries.
 */
function buildClientAccepts(accepted: ParsedEncoding[], preferred: Encoding[]): Set<string> {
  const clientAccepts = new Set<string>();

  for (const entry of accepted) {
    if (entry.quality <= 0) continue;
    if (entry.name === '*') {
      // Wildcard: accept all preferred encodings not explicitly rejected
      for (const enc of preferred) {
        const explicit = accepted.find((e) => e.name === enc);
        if (!explicit || explicit.quality > 0) {
          clientAccepts.add(enc);
        }
      }
    } else {
      clientAccepts.add(entry.name);
    }
  }

  return clientAccepts;
}

/**
 * Select the best encoding based on the Accept-Encoding header and server preferences.
 *
 * Returns `null` if no suitable encoding is found (response should be sent uncompressed).
 */
export function negotiate(
  acceptEncoding: string | undefined,
  preferred: Encoding[] = DEFAULT_ENCODINGS,
): Encoding | null {
  if (!acceptEncoding) return null;

  const accepted = parseAcceptEncoding(acceptEncoding);
  if (accepted.length === 0) return null;

  const clientAccepts = buildClientAccepts(accepted, preferred);

  // Select the first preferred encoding accepted by the client
  for (const enc of preferred) {
    if (clientAccepts.has(enc)) return enc;
  }

  return null;
}
