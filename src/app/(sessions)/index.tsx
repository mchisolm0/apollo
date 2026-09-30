import { useOutbox } from '@/lib/outbox-context';
import { useIncomingShares } from '@/features/sharing';
import type { InboxSession } from '@/features/relay/session-inbox';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConnectionAction, IconButton, relayColors as colors } from '@/features/relay/relay-ui';
import { AgentPicker } from '@/features/relay/agent-picker';
import { SessionList } from '@/features/relay/session-list';
import { useSessionInbox } from '@/features/relay/use-session-inbox';
import { useEkho } from '@/lib';

export default function SessionsRoute() {
  const outbox = useOutbox();
  const { pendingShares } = useIncomingShares();
  const { agentId } = useLocalSearchParams<{ agentId?: string }>();
  const router = useRouter();
  const { agents, runtime, loading, retryAgent } = useEkho();
  const agent = agents.find((candidate) => candidate.id === agentId) ?? agents[0];
  const state = agent ? runtime[agent.id] : undefined;
  const inbox = useSessionInbox(agent?.id ?? '', state);
  if (loading) return <View style={styles.loading}><ActivityIndicator color={colors.primary} accessibilityLabel="Loading agents" /></View>;
  if (!agent) return <Redirect href="/connect" />;
  const connection = state?.status === 'connected' ? 'connected' : state?.status === 'revoked' ? 'revoked' : state?.status === 'connecting' ? 'connecting' : 'offline';
  const open = (id: string) => router.push({ pathname: '/session/[id]', params: { id, agentId: agent.id } });
  const pendingSessions = new Map<string, InboxSession>();
  for (const item of outbox.items) {
    if (item.agentId !== agent.id || inbox.sessions.some((session) => session.id === item.sessionId) || pendingSessions.has(item.sessionId)) continue;
    pendingSessions.set(item.sessionId, { id: item.sessionId, agentId: agent.id, title: (item.text || item.attachments[0]?.name || 'Queued thread').slice(0, 72), updatedAt: 'Queued', activityAt: item.createdAt / 1000, sortAt: item.createdAt / 1000, status: 'active', settled: false, attention: false, pendingApproval: false, queued: true, failed: false, pinned: false, autoSettleDisabled: false });
  }
  const queuedIds = new Set(outbox.items.filter((item) => item.agentId === agent.id).map((item) => item.sessionId));
  const sessions = [...inbox.sessions.map((session) => queuedIds.has(session.id) ? { ...session, queued: true } : session), ...pendingSessions.values()];
  return <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
    <View style={styles.header}>
      <View style={styles.identity}>
        <AgentPicker agents={agents} selected={agent} runtime={runtime}
          onSelect={(agentId) => router.setParams({ agentId })}
          onDetails={(agentId) => router.push({ pathname: '/settings/[agentId]', params: { agentId } })}
          onPair={() => router.push('/connect')} />
      </View>
      <ConnectionAction state={connection} onReconnect={() => void retryAgent(agent.id)} onDetails={() => router.push({ pathname: '/settings/[agentId]', params: { agentId: agent.id } })} />
      <IconButton name="gearshape" label="Settings" onPress={() => router.push('/settings')} />
    </View>
    {pendingShares.length > 0 ? <Pressable accessibilityRole="button" onPress={() => router.push("/share")} style={{ minHeight: 44, paddingHorizontal: 20, justifyContent: "center" }}><Text style={{ color: colors.cyan }}>Open shared content ({pendingShares.length})</Text></Pressable> : null}
    {inbox.error ? <Text style={styles.error} accessibilityRole="alert">{inbox.error}</Text> : null}
    <SessionList connection={connection} sessions={sessions} onSessionPress={(session) => open(session.id)} onSettle={(id) => { void inbox.settle(id); }} onReopen={(id) => { void inbox.reopen(id); }} onNewSession={() => open('new')} onForked={(id) => open(id)} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 52, paddingHorizontal: 12 },
  identity: { flex: 1, minWidth: 0 },
  error: { color: colors.red, fontSize: 14, padding: 20 },
});
