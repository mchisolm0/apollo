// Signs the short-lived JWTs both stores ask for, with WebCrypto so it runs in the Worker.

const ALGORITHMS = {
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
} as const;

export type JwtAlgorithm = keyof typeof ALGORITHMS;

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** Reads a PKCS #8 PEM, the format of both an App Store Connect `.p8` key and a Google service account's `private_key`. */
function pkcs8(pem: string) {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\\n|\s/g, '');
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
}

export async function signJwt(alg: JwtAlgorithm, privateKeyPem: string, header: Record<string, string>, payload: Record<string, unknown>) {
  const { import: params, sign } = ALGORITHMS[alg];
  const key = await crypto.subtle.importKey('pkcs8', pkcs8(privateKeyPem), params, false, ['sign']);
  const input = `${encodeJson({ alg, typ: 'JWT', ...header })}.${encodeJson(payload)}`;
  // ECDSA signs as raw r||s, which is the JWS form ES256 wants.
  const signature = new Uint8Array(await crypto.subtle.sign(sign, key, new TextEncoder().encode(input)));
  return `${input}.${base64url(signature)}`;
}
