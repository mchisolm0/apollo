import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';

import { relayColors } from '@/features/relay';
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
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: relayColors.background } }} />
      </ThemeProvider>
    </EkhoProvider>
    </GestureHandlerRootView>
  );
}
