import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConnectionAction, relayColors as colors } from '@/features/relay/relay-ui';
import { AgentPicker } from '@/features/relay/agent-picker';
import { SessionList } from '@/features/relay/session-list';
import { useSessionInbox } from '@/features/relay/use-session-inbox';
import { useEkho } from '@/lib';

export default function SessionsRoute() {
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
  return <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
    <View style={styles.header}>
      <View style={styles.identity}>
        <AgentPicker agents={agents} selected={agent} runtime={runtime}
          onSelect={(agentId) => router.setParams({ agentId })}
          onDetails={(agentId) => router.push({ pathname: '/settings/[agentId]', params: { agentId } })}
          onPair={() => router.push('/connect')} />
      </View>
      <ConnectionAction state={connection} onReconnect={() => void retryAgent(agent.id)} onDetails={() => router.push({ pathname: '/settings/[agentId]', params: { agentId: agent.id } })} />
    </View>
    {inbox.error ? <Text style={styles.error} accessibilityRole="alert">{inbox.error}</Text> : null}
    <SessionList connection={connection} sessions={inbox.sessions} onSessionPress={(session) => open(session.id)} onSettle={(id) => { void inbox.settle(id); }} onReopen={(id) => { void inbox.reopen(id); }} onNewSession={() => open('new')} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 12 },
  identity: { flex: 1, minWidth: 0 },
  error: { color: colors.red, fontSize: 14, padding: 20 },
});
