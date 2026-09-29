import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppSettingsScreen, relayColors } from '@/features/relay';

export default function AppSettingsRoute() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      {/* Cold links open Settings with nothing behind it; fall back to the inbox. */}
      <AppSettingsScreen onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: relayColors.background },
});
