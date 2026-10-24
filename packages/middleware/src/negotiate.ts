import { DEFAULT_ENCODINGS } from './shared.js';
import type { Encoding } from './types.js';

/** A weight: 0 to 1 with at most three decimals (RFC 9110, section 12.4.2). */
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Read the weight among the parameters of an Accept-Encoding element: 1
 * without a `q` parameter, undefined when its value is not a valid weight.
 * The parameter name is case-insensitive.
 */
function parseWeight(params: readonly string[]): number | undefined {
  for (const param of params) {
    const separator = param.indexOf('=');
    const name = param.slice(0, separator === -1 ? undefined : separator).trim();
    if (name.toLowerCase() !== 'q') {
      continue;
    }
    const value = separator === -1 ? '' : param.slice(separator + 1).trim();
    return QVALUE.test(value) ? Number(value) : undefined;
  }
  return 1;
}

/**
 * Parse an Accept-Encoding field value (RFC 9110, section 12.5.3) into the
 * weight of each listed coding, by lowercase name. Elements whose weight is
 * invalid are ignored, and a coding listed twice keeps its highest weight.
 */
function parseAcceptEncoding(header: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const element of header.split(',')) {
    const [coding = '', ...params] = element.split(';');
    const name = coding.trim().toLowerCase();
    if (name === '') {
      continue;
    }
    const weight = parseWeight(params);
    if (weight === undefined) {
      continue;
    }
    weights.set(name, Math.max(weight, weights.get(name) ?? 0));
  }
  return weights;
}

/**
 * Select the encoding for a response from the request's Accept-Encoding and
 * the server's preference.
 *
 * Returns the first of `preferred` that the client accepts: listed with a
 * weight above 0, or covered by `*` with a weight above 0. Among acceptable
 * encodings the server's order decides, not the client's weights. Coding
 * names and the `q` parameter are case-insensitive, and elements with a
 * weight outside the `qvalue` grammar (0 to 1, up to three decimals) are
 * ignored.
 *
 * Returns `null` when the client accepts none of them, sends an empty field,
 * or sends no field at all: the response should then be sent uncompressed.
 */
export function negotiate(
  acceptEncoding: string | undefined,
  preferred: readonly Encoding[] = DEFAULT_ENCODINGS,
): Encoding | null {
  if (acceptEncoding === undefined) {
    return null;
  }
  const weights = parseAcceptEncoding(acceptEncoding);
  const wildcard = weights.get('*') ?? 0;
  return preferred.find((encoding) => (weights.get(encoding) ?? wildcard) > 0) ?? null;
}
