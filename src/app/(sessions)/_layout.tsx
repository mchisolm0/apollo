import { HAS_MAIL_TOOLBAR } from '@/features/relay/mail-toolbar';
import { useColors } from '@/features/relay/relay-ui';
import { Stack } from 'expo-router';

export const unstable_settings = { initialRouteName: 'index' };

export default function SessionLayout() {
  const colors = useColors();
  // The inbox's native header is declared here, not only from the screen, so it is laid out on the
  // first frame instead of appearing once the screen renders and pushing the content down.
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
    <Stack.Screen name="index" options={{ headerShown: HAS_MAIL_TOOLBAR, title: '', headerStyle: { backgroundColor: colors.background }, headerShadowVisible: false }} />
  </Stack>;
}
