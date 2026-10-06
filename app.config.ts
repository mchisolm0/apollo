import type { ConfigContext, ExpoConfig } from 'expo/config';

/** Each variant has its own installation, pairing, and draft storage. */
export default function configure({ config }: ConfigContext): ExpoConfig {
  const variant = process.env.APOLLO_APP_VARIANT ?? 'production';
  if (!['development', 'preview', 'production'].includes(variant)) {
    throw new Error(`Unknown APOLLO_APP_VARIANT: ${variant}`);
  }
  const suffix = variant === 'development' ? '.dev' : variant === 'preview' ? '.preview' : '';
  return {
    ...config,
    name: variant === 'development' ? 'Apollo Dev' : variant === 'preview' ? 'Apollo Preview' : config.name ?? 'Apollo',
    slug: config.slug ?? 'apollo',
    scheme: variant === 'development' ? 'apollo-dev' : variant === 'preview' ? 'apollo-preview' : 'apollo',
    updates: {
      ...config.updates,
      requestHeaders: { 'expo-channel-name': variant === 'development' ? 'apollo-dev' : variant },
    },
    extra: {
      ...config.extra,
      releaseNotes: (process.env.RELEASE_NOTES ?? '').split('\n').map((line: string) => line.trim()).filter(Boolean),
      posthogProjectToken: process.env.POSTHOG_PROJECT_TOKEN,
      posthogHost: process.env.POSTHOG_HOST,
    },
    plugins: [...(config.plugins ?? []), 'expo-notifications', ['expo-sharing', {
      ios: { enabled: true, extensionBundleIdentifier: `com.matthewchisolm.apollo${suffix}.sharing`, appGroupId: `group.com.matthewchisolm.apollo${suffix}`, activationRule: { supportsText: true, supportsWebUrlWithMaxCount: 1, supportsImageWithMaxCount: 4, supportsFileWithMaxCount: 4 } },
      android: { enabled: true, singleShareMimeTypes: ['*/*'], multipleShareMimeTypes: ['*/*'] },
    }]],
    ios: { ...config.ios, bundleIdentifier: `com.matthewchisolm.apollo${suffix}` },
    android: { ...config.android, package: `com.matthewchisolm.apollo${suffix}` },
  };
}
