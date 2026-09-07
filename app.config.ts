import type { ConfigContext, ExpoConfig } from 'expo/config';

/** Install the local test client beside Ekho, with its own pairing and draft state. */
export default function configure({ config }: ConfigContext): ExpoConfig {
  const development = process.env.EKHO_APP_VARIANT === 'development';
  return {
    ...config,
    name: development ? 'Ekho Dev' : config.name ?? 'Ekho',
    slug: config.slug ?? 'ekho',
    scheme: development ? 'ekho-dev' : 'ekho',
    ...(development ? {
      runtimeVersion: { policy: 'fingerprint' as const },
      updates: {
        url: 'https://u.expo.dev/abbd4780-e7ac-4ac1-8727-b278e6bd0ec3',
        requestHeaders: { 'expo-channel-name': 'ekho-dev' },
      },
    } : {}),
    ios: { ...config.ios, bundleIdentifier: development ? 'com.matthewchisolm.ekho.dev' : 'com.matthewchisolm.ekho' },
    android: { ...config.android, package: development ? 'com.matthewchisolm.ekho.dev' : 'com.matthewchisolm.ekho' },
  };
}
