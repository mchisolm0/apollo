export function attachmentCacheIdentity(uri: string, attachmentId: string): string {
  const url = new URL(uri);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('This attachment location cannot be opened.');
  return `${url.origin}${url.pathname}\0${attachmentId}`;
}
