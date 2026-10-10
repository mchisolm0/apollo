import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ConnectionAction, ConnectionMark, connectionLabels, RelayButton, useColors, useRelayStyles, useThemedStyles, type RelayPalette } from './relay-ui';
import { SettingRow, SettingSection, SettingsHeader } from './settings-ui';
import type { RelayAgent } from './types';

export type AgentSettingsScreenProps = {
  agent: RelayAgent;
  deviceName: string;
  pairedAt?: string;
  onBack?: () => void;
  onTestConnection?: () => void;
  onForgetAgent?: () => void;
  onNotifications?: () => void;
  onToolsets?: () => void;
  defaultModel?: string;
  platform?: string;
  /** Cloud inbox status for this phone; `onPress` sets it up or reconnects. */
  cloudInbox?: { value: string; action?: string; onPress?: () => void };
};

/** One agent's connection and pairing details, opened from the agent picker. App-wide preferences live in AppSettingsScreen. */
export function AgentSettingsScreen({ agent, deviceName, pairedAt, onBack, onTestConnection, onForgetAgent, onNotifications, onToolsets, defaultModel, platform, cloudInbox }: AgentSettingsScreenProps) {
  const styles = useThemedStyles(createStyles);
  const uiStyles = useRelayStyles();
  const colors = useColors();
  const agentPlatform = platform ?? agent.platform;
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
          <SettingRow label="Endpoint" value={agent.endpoint} />
          <SettingRow label="Route" value={agent.transport === 'tailscale' ? 'Tailscale Serve' : agent.endpoint.startsWith('http:') ? 'Local development' : 'HTTPS'} />
          <SettingRow label="Status" value={connectionLabels[agent.connection]} />
          <SettingRow label="Last seen" value={agent.lastSeen ?? 'Not yet'} />
          {agentPlatform ? <SettingRow label="Platform" value={agentPlatform} /> : null}
          {defaultModel ? <SettingRow label="Default model" value={defaultModel} /> : null}
          {onToolsets ? <SettingRow label="Toolsets" value="" action="View" onPress={onToolsets} /> : null}
        </SettingSection>
        {onTestConnection ? <ConnectionAction state={agent.connection} onReconnect={onTestConnection} /> : null}
        {onTestConnection && agent.connection === 'connected' ? <View style={styles.primaryAction}><Pressable accessibilityRole="button" onPress={onTestConnection} style={styles.testConnection}><Text style={[styles.testConnectionText, { color: colors.cyan }]}>Test connection</Text></Pressable></View> : null}

        <SettingSection label="This device">
          <SettingRow label="Name" value={deviceName} />
          <SettingRow label="Notifications" value="Configure" onPress={onNotifications} />
          {cloudInbox ? <SettingRow label="Cloud inbox" value={cloudInbox.value} action={cloudInbox.action} onPress={cloudInbox.onPress} /> : null}
          {pairedAt ? <SettingRow label="Paired" value={pairedAt} /> : null}
        </SettingSection>
        <View style={styles.dangerSection}>
          {onForgetAgent ? <RelayButton tone="destructive" onPress={onForgetAgent}>Forget agent</RelayButton> : null}
          <Text style={styles.dangerHelp}>
            Forget removes local access. Revoke a lost phone from the connector CLI.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  identity: { paddingTop: 24, paddingBottom: 18, gap: 7 },
  agentName: { color: colors.primary, fontSize: 30, lineHeight: 36, fontWeight: '600', paddingTop: 6 },
  primaryAction: { paddingTop: 8 },
  testConnection: { minHeight: 44, justifyContent: 'center' }, testConnectionText: { fontSize: 15 },
  dangerSection: { paddingTop: 28, gap: 10 },
  dangerHelp: { color: colors.muted, fontSize: 12, lineHeight: 17, paddingTop: 2, maxWidth: 330 },
});
