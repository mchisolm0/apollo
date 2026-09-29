import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ConnectionAction, ConnectionMark, connectionLabels, RelayButton, relayColors, useColors, styles as uiStyles } from './relay-ui';
import { SettingRow, SettingSection, SettingsHeader } from './settings-ui';
import type { RelayAgent } from './types';

export type AgentSettingsScreenProps = {
  agent: RelayAgent;
  deviceName?: string;
  pairedAt?: string;
  onBack?: () => void;
  onTestConnection?: () => void;
  onEditEndpoint?: () => void;
  onRevokeDevice?: () => void;
  onForgetAgent?: () => void;
};

/** One agent's connection and pairing details, opened from the agent picker. App-wide preferences live in AppSettingsScreen. */
export function AgentSettingsScreen({ agent, deviceName = 'This device', pairedAt, onBack, onTestConnection, onEditEndpoint, onRevokeDevice, onForgetAgent }: AgentSettingsScreenProps) {
  const colors = useColors();
  return (
    <View style={uiStyles.screen}>
      <SettingsHeader title="Agent" onBack={onBack} />
      <ScrollView contentContainerStyle={uiStyles.content}>
        <View style={styles.identity}>
          <ConnectionMark state={agent.connection} label />
          <Text style={styles.agentName}>{agent.name}</Text>
        </View>

        <SettingSection label="Connection">
          {agent.hostname !== agent.name ? <SettingRow label="Host" value={agent.hostname} /> : null}
          <SettingRow label="Endpoint" value={agent.endpoint} onPress={onEditEndpoint} />
          <SettingRow label="Route" value={agent.transport === 'tailscale' ? 'Tailscale Serve' : agent.endpoint.startsWith('http:') ? 'Local development' : 'HTTPS'} />
          <SettingRow label="Status" value={connectionLabels[agent.connection]} />
          <SettingRow label="Last seen" value={agent.lastSeen ?? 'Not yet'} />
          {agent.platform ? <SettingRow label="Platform" value={agent.platform} /> : null}
        </SettingSection>
        {onTestConnection ? <ConnectionAction state={agent.connection} onReconnect={onTestConnection} /> : null}
        {onTestConnection ? <View style={styles.primaryAction}><Pressable accessibilityRole="button" onPress={onTestConnection} style={styles.testConnection}><Text style={[styles.testConnectionText, { color: colors.cyan }]}>Test connection</Text></Pressable></View> : null}

        <SettingSection label="This device">
          <SettingRow label="Name" value={deviceName} />
          {pairedAt ? <SettingRow label="Paired" value={pairedAt} /> : null}
        </SettingSection>
        <View style={styles.dangerSection}>
          {onRevokeDevice ? <RelayButton tone="amber" onPress={onRevokeDevice}>Revoke this device</RelayButton> : null}
          {onForgetAgent ? <RelayButton tone="destructive" onPress={onForgetAgent}>Forget agent</RelayButton> : null}
          <Text style={styles.dangerHelp}>
            {onRevokeDevice
              ? 'Revoking blocks this phone. Forgetting removes the saved endpoint.'
              : 'Forget removes local access. Revoke a lost phone from the connector CLI.'}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  identity: { paddingTop: 24, paddingBottom: 18, gap: 7 },
  agentName: { color: relayColors.primary, fontSize: 30, lineHeight: 36, fontWeight: '600', paddingTop: 6 },
  primaryAction: { paddingTop: 8 },
  testConnection: { minHeight: 44, justifyContent: 'center' }, testConnectionText: { fontSize: 15 },
  dangerSection: { paddingTop: 28, gap: 10 },
  dangerHelp: { color: relayColors.muted, fontSize: 12, lineHeight: 17, paddingTop: 2, maxWidth: 330 },
});
