import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { HAS_MAIL_TOOLBAR } from '@/features/relay/mail-toolbar';
import { useColors } from '@/features/relay/relay-ui';
import { InboxPane } from '@/features/layout/inbox-pane';
import { sidebarOpenAction } from '@/features/layout/split-layout';
import { useSidebarWidth } from '@/features/layout/use-sidebar-width';
import { Stack, useGlobalSearchParams, usePathname, useRouter } from 'expo-router';

export const unstable_settings = { initialRouteName: 'index' };

export default function SessionLayout() {
  const colors = useColors();
  const sidebarWidth = useSidebarWidth();
  const split = sidebarWidth !== undefined;
  // One tree in both modes, so rotating or resizing across the breakpoint keeps the stack and its open thread.
  // The inbox's native header is declared here, not only from the screen, so it is laid out on the
  // first frame instead of appearing once the screen renders and pushing the content down.
  return <View style={styles.row}>
    {split ? <View style={[styles.sidebar, { width: sidebarWidth, borderRightColor: colors.line }]}><Sidebar /></View> : null}
    <View style={styles.detail}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Screen name="index" options={{ headerShown: HAS_MAIL_TOOLBAR && !split, title: '', headerStyle: { backgroundColor: colors.background }, headerShadowVisible: false }} />
        {/* The sidebar is the way between threads, so the pane swaps instantly and has no back swipe. */}
        <Stack.Screen name="session/[id]" options={split ? { animation: 'none', gestureEnabled: false } : {}} />
      </Stack>
    </View>
  </View>;
}

/** The inbox beside the stack. It follows the open thread's agent, so a deep link to another agent's thread shows that agent's list. */
function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ id?: string; agentId?: string }>();
  const inThread = pathname.startsWith('/session/');
  // Screens pushed over the whole app carry their own params; only the inbox and threads choose the list.
  const routeAgentId = inThread || pathname === '/' ? params.agentId : undefined;
  const [agentId, setAgentId] = useState(routeAgentId);
  const [seenRouteAgentId, setSeenRouteAgentId] = useState(routeAgentId);
  if (routeAgentId !== seenRouteAgentId) {
    setSeenRouteAgentId(routeAgentId);
    if (routeAgentId) setAgentId(routeAgentId);
  }
  return <InboxPane sidebar agentId={agentId} selectedId={inThread ? params.id : undefined}
    onSelectAgent={setAgentId}
    onOpen={(params) => {
      const href = { pathname: '/session/[id]', params } as const;
      if (sidebarOpenAction(pathname) === 'replace') router.replace(href);
      else router.push(href);
    }} />;
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  sidebar: { borderRightWidth: StyleSheet.hairlineWidth },
  detail: { flex: 1 },
});
