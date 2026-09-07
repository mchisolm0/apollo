export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const url = new URL(path, 'ekho://app');
    if ((url.protocol === 'ekho:' || url.protocol === 'ekho-dev:') && url.hostname === 'pair') {
      return `/connect?link=${encodeURIComponent(path.replace(/^ekho-dev:/, 'ekho:'))}`;
    }
    return path;
  } catch {
    return '/connect';
  }
}
