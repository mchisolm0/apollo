import type { ConfigContext, ExpoConfig } from 'expo/config';

/** Each variant has its own installation, pairing, and draft storage. */
export default function configure({ config }: ConfigContext): ExpoConfig {
  const variant = process.env.EKHO_APP_VARIANT ?? 'production';
  if (!['development', 'preview', 'production'].includes(variant)) {
    throw new Error(`Unknown EKHO_APP_VARIANT: ${variant}`);
  }
  const suffix = variant === 'development' ? '.dev' : variant === 'preview' ? '.preview' : '';
  return {
    ...config,
    name: variant === 'development' ? 'Ekho Dev' : variant === 'preview' ? 'Ekho Preview' : config.name ?? 'Ekho',
    slug: config.slug ?? 'ekho',
    scheme: variant === 'development' ? 'ekho-dev' : variant === 'preview' ? 'ekho-preview' : 'ekho',
    updates: {
      ...config.updates,
      requestHeaders: { 'expo-channel-name': variant === 'development' ? 'ekho-dev' : variant },
    },
    ios: { ...config.ios, bundleIdentifier: `com.matthewchisolm.ekho${suffix}` },
    android: { ...config.android, package: `com.matthewchisolm.ekho${suffix}` },
  };
}
