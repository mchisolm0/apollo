import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { ConnectionAction, ConnectionMark, RelayButton, RelayHeader, relayColors, styles as uiStyles } from './relay-ui';
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

export function AgentSettingsScreen({ agent, deviceName = 'This device', pairedAt, onBack, onTestConnection, onEditEndpoint, onRevokeDevice, onForgetAgent }: AgentSettingsScreenProps) {
  return (
    <View style={uiStyles.screen}>
      <RelayHeader title="Agent settings" onBack={onBack} action={<ConnectionAction state={agent.connection} onReconnect={onTestConnection} />} />
      <ScrollView contentContainerStyle={uiStyles.content}>
        <View style={styles.identity}>
          <ConnectionMark state={agent.connection} label />
          <Text style={styles.agentName}>{agent.name}</Text>
          {agent.hostname !== agent.name ? <Text style={styles.hostname}>{agent.hostname}</Text> : null}
        </View>

        <SettingSection label="Connection">
          <SettingRow label="Endpoint" value={agent.endpoint} onPress={onEditEndpoint} />
          <SettingRow label="Route" value={agent.transport === 'tailscale' ? 'Tailscale Serve' : agent.endpoint.startsWith('http:') ? 'Local development' : 'HTTPS'} />
          <SettingRow label="Last seen" value={agent.lastSeen ?? 'Not yet'} />
          {agent.platform ? <SettingRow label="Platform" value={agent.platform} /> : null}
        </SettingSection>
        {onTestConnection ? <View style={styles.primaryAction}><Pressable accessibilityRole="button" onPress={onTestConnection} style={styles.testConnection}><Text style={styles.testConnectionText}>Test connection</Text></Pressable></View> : null}

        <SettingSection label="This device">
          <SettingRow label="Name" value={deviceName} />
          {pairedAt ? <SettingRow label="Paired" value={pairedAt} /> : null}
        </SettingSection>
        <SettingSection label="App">
          <SettingRow label="Version" value={Constants.expoConfig?.version ?? 'Unknown'} />
          <SettingRow label="Fingerprint" value={Updates.runtimeVersion ?? 'Unavailable in development'} />
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

function SettingSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.rows}>{children}</View>
    </View>
  );
}

function SettingRow({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  const { fontScale } = useWindowDimensions();
  const large = fontScale > 1.3;
  const rowStyle = [styles.row, large && styles.rowLarge];
  const content = <><Text style={[styles.rowLabel, large && { width: 'auto' }]}>{label}</Text><Text style={[styles.rowValue, large && { flex: 0, alignSelf: 'stretch', paddingVertical: 0 }]} selectable>{value}</Text>{onPress ? <Text style={styles.rowAction}>Edit</Text> : null}</>;
  if (!onPress) return <View style={rowStyle}>{content}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${label}`} onPress={onPress} style={({ pressed }) => [rowStyle, { opacity: pressed ? 0.65 : 1 }]}>{content}</Pressable>;
}

const styles = StyleSheet.create({
  identity: { paddingTop: 24, paddingBottom: 18, gap: 7 },
  agentName: { color: relayColors.primary, fontSize: 30, lineHeight: 36, fontWeight: '600', paddingTop: 6 },
  hostname: { color: relayColors.secondary, fontSize: 13 },
  section: { paddingTop: 22, gap: 8 },
  sectionLabel: { color: relayColors.primary, fontSize: 14, fontWeight: '600' },
  rows: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: relayColors.line },
  row: { minHeight: 50, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: relayColors.line, flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowLarge: { flexDirection: 'column', alignItems: 'flex-start', gap: 6, paddingVertical: 12 },
  rowLabel: { color: relayColors.secondary, fontSize: 14, width: 82 },
  rowValue: { color: relayColors.primary, fontSize: 15, flex: 1, paddingVertical: 12 },
  rowAction: { color: relayColors.cyan, fontSize: 12, fontWeight: '600' },
  primaryAction: { paddingTop: 8 },
  testConnection: { minHeight: 44, justifyContent: 'center' }, testConnectionText: { color: relayColors.cyan, fontSize: 15 },
  dangerSection: { paddingTop: 28, gap: 10 },
  dangerHelp: { color: relayColors.muted, fontSize: 12, lineHeight: 17, paddingTop: 2, maxWidth: 330 },
});
