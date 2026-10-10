import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CardDetailScreen } from '@/features/cloud/card-detail-screen';
import { useThemedStyles, type RelayPalette } from '@/features/relay/relay-ui';

export default function CardRoute() {
  const styles = useThemedStyles(createStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  return <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
    <CardDetailScreen cardId={id} onBack={() => router.canGoBack() ? router.back() : router.replace('/')} />
  </SafeAreaView>;
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
});
