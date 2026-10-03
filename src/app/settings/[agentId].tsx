import { useThemedStyles, type RelayPalette } from '@/features/relay/relay-ui';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AgentSettingsScreen } from '@/features/relay';
import type { RelayAgent } from '@/features/relay';
import { useEkho } from '@/lib';

export default function SettingsRoute() {
  const styles = useThemedStyles(createStyles);
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const router = useRouter();
  const { agents, runtime, refreshAgent, removeAgent } = useEkho();
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (!agent) return <Redirect href="/" />;
  const status = runtime[agent.id]?.status;
  const connection: RelayAgent['connection'] = status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : status === 'revoked' ? 'revoked' : 'offline';
  const relayAgent: RelayAgent = {
    id: agent.id,
    name: agent.label,
    hostname: agent.hostname ?? new URL(agent.endpoint.url).hostname,
    endpoint: agent.endpoint.url,
    transport: agent.endpoint.transport === 'tailscale' ? 'tailscale' : 'https',
    connection,
    lastSeen: agent.lastConnectedAt ? new Date(agent.lastConnectedAt).toLocaleString() : undefined,
    platform: agent.capabilities?.platform,
  };

  const confirmForget = () => Alert.alert(
    'Forget this agent?',
    'The saved device credential will be removed from this phone. Revoke it from the connector CLI if the phone is lost.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: () => void removeAgent(agent.id)
          .then(() => router.replace('/agents'))
          .catch((error: unknown) => Alert.alert('Could not forget agent', error instanceof Error ? error.message : 'Try again.')),
      },
    ],
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <AgentSettingsScreen
        agent={relayAgent}
        pairedAt={new Date(agent.createdAt).toLocaleDateString()}
        onBack={() => router.back()}
        onTestConnection={() => void refreshAgent(agent.id)}
        onForgetAgent={confirmForget}
        onNotifications={() => router.push({ pathname: "/notifications/[agentId]", params: { agentId } })}
      />
    </SafeAreaView>
  );
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
});
