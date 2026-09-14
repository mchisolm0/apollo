import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';

import { relayColors } from '@/features/relay';
import { TextScaleProvider } from '@/features/relay/relay-ui';
import { EkhoProvider } from '@/lib';

const ekhoTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: relayColors.cyan,
    background: relayColors.background,
    card: relayColors.background,
    text: relayColors.primary,
    border: relayColors.line,
    notification: relayColors.red,
  },
};

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <EkhoProvider>
      <ThemeProvider value={ekhoTheme}>
        <StatusBar style="light" />
        <TextScaleProvider>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: relayColors.background } }}>
          <Stack.Screen name="settings/[agentId]" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.7, 0.92], sheetGrabberVisible: true, sheetCornerRadius: 32 }} />
        </Stack>
        </TextScaleProvider>
      </ThemeProvider>
    </EkhoProvider>
    </GestureHandlerRootView>
  );
}
