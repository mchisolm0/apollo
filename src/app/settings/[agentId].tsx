import { useThemedStyles, type RelayPalette } from '@/features/relay/relay-ui';
import * as Device from 'expo-device';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AgentSettingsScreen } from '@/features/relay';
import type { RelayAgent } from '@/features/relay';
import { useApollo, type AwayMode } from '@/lib';
import { useCloud, type CloudStatus } from '@/features/cloud/cloud-context';

const cloudLabels = { off: 'Not set up', connecting: 'Connecting', live: 'Connected', offline: 'Offline', revoked: 'Access revoked' } as const satisfies Record<CloudStatus, string>;

export default function SettingsRoute() {
  const styles = useThemedStyles(createStyles);
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const router = useRouter();
  const { agents, runtime, refreshAgent, removeAgent, renameAgent, awayMode } = useApollo();
  const cloud = useCloud();
  const [away, setAway] = useState<AwayMode>();
  const [awayBusy, setAwayBusy] = useState(false);
  const connected = runtime[agentId]?.status === 'connected';
  useEffect(() => {
    if (!connected) return;
    let current = true;
    // Older connectors and offline agents leave the row hidden.
    void awayMode(agentId).then((value) => { if (current) setAway(value); }).catch(() => {});
    return () => { current = false; };
  }, [agentId, awayMode, connected]);
  const changeAway = (on: boolean) => {
    setAwayBusy(true);
    void awayMode(agentId, on)
      .then((value) => {
        setAway(value);
        if (!on && value && value.denied > 0) Alert.alert('Not in the inbox yet', `${value.denied} denied while away. Retry from here.`);
      })
      .catch((error: unknown) => Alert.alert('Could not change away mode', error instanceof Error ? error.message : 'Try again.'))
      .finally(() => setAwayBusy(false));
  };
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (!agent) return <Redirect href="/" />;
  const connectCloud = () => void cloud.connect(agent.id).catch((error: unknown) => Alert.alert('Could not set up the cloud inbox', error instanceof Error ? error.message : 'Try again.'));
  const cloudOwner = cloud.credential ? agents.find((candidate) => candidate.id === cloud.credential?.agentId)?.label : undefined;
  const cloudInbox = !cloud.credential ? { value: cloudLabels.off, action: 'Set up', onPress: connectCloud }
    : cloud.credential.agentId !== agent.id ? { value: `${cloudLabels[cloud.status]} via ${cloudOwner ?? 'another agent'}` }
      : cloud.status === 'revoked' ? { value: cloudLabels.revoked, action: 'Reconnect', onPress: connectCloud }
        : { value: cloudLabels[cloud.status] };
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
        key={agent.id}
        agent={relayAgent}
        defaultModel={(runtime[agentId]?.capabilities ?? agent.capabilities)?.model}
        platform={(runtime[agentId]?.capabilities ?? agent.capabilities)?.platform}
        deviceName={agent.deviceName ?? Device.deviceName ?? 'Apollo mobile'}
        pairedAt={new Date(agent.createdAt).toLocaleDateString()}
        onBack={() => router.back()}
        onTestConnection={() => refreshAgent(agent.id)}
        connectionError={runtime[agent.id]?.error}
        onRename={(label) => renameAgent(agent.id, label)}
        onForgetAgent={confirmForget}
        onNotifications={() => router.push({ pathname: "/notifications/[agentId]", params: { agentId } })}
        onToolsets={() => router.push({ pathname: '/toolsets/[agentId]', params: { agentId } })}
        cloudInbox={cloudInbox}
        away={away ? { on: away.on, denied: away.denied, busy: awayBusy, onChange: changeAway } : undefined}
      />
    </SafeAreaView>
  );
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
});
