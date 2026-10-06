export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const url = new URL(path, 'apollo://app');
    if (['apollo:', 'apollo-dev:', 'apollo-preview:'].includes(url.protocol) && url.hostname === 'expo-sharing') return '/share';
    if (['apollo:', 'apollo-dev:', 'apollo-preview:'].includes(url.protocol) && url.hostname === 'pair') {
      return `/connect?link=${encodeURIComponent(path.replace(/^apollo-(?:dev|preview):/, 'apollo:'))}`;
    }
    return path;
  } catch {
    return '/connect';
  }
}
