import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';

import { TextScaleProvider, useColors } from '@/features/relay/relay-ui';
import { EkhoProvider } from '@/lib';

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
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <EkhoProvider>
      <TextScaleProvider>
        <InnerStack />
      </TextScaleProvider>
    </EkhoProvider>
    </GestureHandlerRootView>
  );
}
