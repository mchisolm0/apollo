import { useEffect } from 'react';
import { PostHogProvider } from 'posthog-react-native';
import { posthog } from '@/config/posthog';
import { DarkTheme, Stack, ThemeProvider, usePathname } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';

import { TextScaleProvider, useColors } from '@/features/relay/relay-ui';
import { SessionInboxAutoSettle } from '@/features/relay/use-session-inbox';
import { ApolloProvider, useApollo } from '@/lib';
import { OutboxProvider } from '@/lib/outbox-context';
import { CloudProvider } from '@/features/cloud/cloud-context';
import { IncomingShareProvider } from '@/features/sharing';
import { NotificationNavigation } from '@/features/notifications';
import { AppShortcuts } from '@/features/shortcuts/AppShortcuts';
import { AppUpdateProvider } from '@/features/updates/update-provider';
import { UpdateReadyNotice } from '@/features/updates/update-ui';

function InnerStack() {
  const colors = useColors();
  const theme = {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      primary: colors.cyan,
      background: colors.background,
      card: colors.chrome,
      text: colors.primary,
      border: colors.line,
      notification: colors.red,
    },
  };
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <ScreenTracker />
      <NotificationNavigation />
      <AppShortcuts />
      <InboxAutoSettle />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />
    </ThemeProvider>
  );
}

function InboxAutoSettle() {
  const { agents, runtime } = useApollo();
  return agents.map((agent) => <SessionInboxAutoSettle key={agent.id} agentId={agent.id} state={runtime[agent.id]} />);
}

function ScreenTracker() {
  const pathname = usePathname();
  useEffect(() => { posthog.screen(pathname); }, [pathname]);
  return null;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <PostHogProvider client={posthog} autocapture={false}>
    <ApolloProvider>
      <OutboxProvider>
      <CloudProvider>
      <IncomingShareProvider>
      <TextScaleProvider>
        <AppUpdateProvider>
        <InnerStack />
        <UpdateReadyNotice />
        </AppUpdateProvider>
      </TextScaleProvider>
      </IncomingShareProvider>
      </CloudProvider>
      </OutboxProvider>
    </ApolloProvider>
    </PostHogProvider>
    </GestureHandlerRootView>
  );
}
