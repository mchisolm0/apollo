import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeedbackScreen } from '@/features/cloud/feedback-screen';
import { useThemedStyles, type RelayPalette } from '@/features/relay/relay-ui';

export default function FeedbackRoute() {
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  return <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
    <FeedbackScreen onBack={() => router.canGoBack() ? router.back() : router.replace('/')} />
  </SafeAreaView>;
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
});
