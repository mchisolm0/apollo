import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';

import { TextScaleProvider, useColors } from '@/features/relay/relay-ui';
import { EkhoProvider } from '@/lib';
import { OutboxProvider } from '@/lib/outbox-context';
import { IncomingShareProvider } from '@/features/sharing';
import { NotificationNavigation } from '@/features/notifications';

function InnerStack() {
  const colors = useColors();
  const theme = {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      primary: colors.cyan,
      background: colors.background,
      card: colors.background,
      text: colors.primary,
      border: colors.line,
      notification: colors.red,
    },
  };
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <NotificationNavigation />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <EkhoProvider>
      <OutboxProvider>
      <IncomingShareProvider>
      <TextScaleProvider>
        <InnerStack />
      </TextScaleProvider>
      </IncomingShareProvider>
      </OutboxProvider>
    </EkhoProvider>
    </GestureHandlerRootView>
  );
}
