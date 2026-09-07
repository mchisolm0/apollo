/** Credentials require HTTPS across the network; loopback supports local development. */
export function normalizeEndpoint(value: string): string {
  const endpoint = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    throw new Error('Use an HTTPS endpoint. HTTP is only supported for a local development connector.');
  }
  if (endpoint.username || endpoint.password) throw new Error('Endpoint cannot include credentials');
  return endpoint.toString().replace(/\/$/, '');
}
