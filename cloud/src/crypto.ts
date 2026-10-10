const encoder = new TextEncoder();

export const sha256 = (text: string) => crypto.subtle.digest('SHA-256', encoder.encode(text));

export const sha256Hex = async (text: string) => new Uint8Array(await sha256(text)).toHex();

/** A new bearer token. Only its SHA-256 hash is ever stored. */
export const newToken = () =>
  `apollo_${crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: 'base64url', omitPadding: true })}`;

/**
 * Compares two secrets in constant time. Hashing first gives both sides the
 * same length, so the comparison leaks neither content nor length.
 */
export async function secretsMatch(presented: string, expected: string) {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}
