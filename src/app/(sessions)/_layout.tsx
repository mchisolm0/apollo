import { useColors } from '@/features/relay/relay-ui';
import { Stack } from 'expo-router';

export const unstable_settings = { initialRouteName: 'index' };

export default function SessionLayout() {
  const colors = useColors();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}
