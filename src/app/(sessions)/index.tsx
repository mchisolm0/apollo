import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { InboxPane } from '@/features/layout/inbox-pane';
import { useSidebarWidth } from '@/features/layout/use-sidebar-width';

export default function SessionsRoute() {
  const { agentId } = useLocalSearchParams<{ agentId?: string }>();
  const router = useRouter();
  const split = useSidebarWidth() !== undefined;
  // On a wide window the inbox is the sidebar, and this route is the empty detail pane. Options set by the
  // inbox before a resize stay on the route, so clear its header and toolbar.
  if (split) return <Stack.Screen options={{ headerShown: false, unstable_nativeProps: { headerConfig: { headerToolbarItems: [] } } }} />;
  return <InboxPane agentId={agentId}
    onSelectAgent={(agentId) => router.setParams({ agentId })}
    onOpen={(params) => router.push({ pathname: '/session/[id]', params })} />;
}
