export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const url = new URL(path, 'ekho://app');
    if (['ekho:', 'ekho-dev:', 'ekho-preview:'].includes(url.protocol) && url.hostname === 'pair') {
      return `/connect?link=${encodeURIComponent(path.replace(/^ekho-(?:dev|preview):/, 'ekho:'))}`;
    }
    return path;
  } catch {
    return '/connect';
  }
}
