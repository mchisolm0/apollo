import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import type { ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { ConnectionAction, ConnectionMark, connectionLabels, IconButton, RelayButton, relayColors, TEXT_SCALE_FACTORS, useTextScale, styles as uiStyles } from './relay-ui';
import type { TextScaleKey } from './relay-ui';
import type { RelayAgent } from './types';

export type AgentSettingsScreenProps = {
  agent: RelayAgent;
  deviceName?: string;
  environmentCount?: number;
  pairedAt?: string;
  onBack?: () => void;
  onTestConnection?: () => void;
  onEditEndpoint?: () => void;
  onRevokeDevice?: () => void;
  onForgetAgent?: () => void;
};

const TEXT_SIZE_ORDER: readonly TextScaleKey[] = ['small', 'default', 'large'];
const TEXT_SIZE_LABELS: Record<TextScaleKey, string> = { small: 'Small', default: 'Default', large: 'Large' };

export function AgentSettingsScreen({ agent, deviceName = 'This device', environmentCount, pairedAt, onBack, onTestConnection, onEditEndpoint, onRevokeDevice, onForgetAgent }: AgentSettingsScreenProps) {
  const { scale, factor, setScale } = useTextScale();
  return (
    <View style={uiStyles.screen}>
      <View style={styles.header}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={[styles.headerSlot, styles.headerAction]}>{onBack ? <IconButton name="xmark" label="Close settings" onPress={onBack} /> : null}</View>
      </View>
      <ScrollView contentContainerStyle={uiStyles.content}>
        <View style={styles.identity}>
          <ConnectionMark state={agent.connection} label />
          <Text style={styles.agentName}>{agent.name}</Text>
          {agent.hostname !== agent.name ? <Text style={styles.hostname}>{agent.hostname}</Text> : null}
        </View>

        <SettingSection label="Account">
          <SettingRow label="Account" value={agent.name} />
          <SettingRow label="Host" value={agent.hostname} />
          {environmentCount !== undefined ? <SettingRow label="Environments" value={String(environmentCount)} /> : null}
        </SettingSection>

        <SettingSection label="Connection">
          <SettingRow label="Endpoint" value={agent.endpoint} onPress={onEditEndpoint} />
          <SettingRow label="Route" value={agent.transport === 'tailscale' ? 'Tailscale Serve' : agent.endpoint.startsWith('http:') ? 'Local development' : 'HTTPS'} />
          <SettingRow label="Status" value={connectionLabels[agent.connection]} />
          <SettingRow label="Last seen" value={agent.lastSeen ?? 'Not yet'} />
          {agent.platform ? <SettingRow label="Platform" value={agent.platform} /> : null}
        </SettingSection>
        {onTestConnection ? <ConnectionAction state={agent.connection} onReconnect={onTestConnection} /> : null}
        {onTestConnection ? <View style={styles.primaryAction}><Pressable accessibilityRole="button" onPress={onTestConnection} style={styles.testConnection}><Text style={styles.testConnectionText}>Test connection</Text></Pressable></View> : null}

        <SettingSection label="Appearance">
          {TEXT_SIZE_ORDER.map((option) => (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityLabel={`Text size ${TEXT_SIZE_LABELS[option]}`}
              accessibilityState={{ selected: option === scale }}
              onPress={() => void setScale(option)}
              style={({ pressed }) => [styles.row, { opacity: pressed ? 0.65 : 1 }]}
            >
              <Text style={styles.rowLabel}>{TEXT_SIZE_LABELS[option]}</Text>
              <Text style={{ color: relayColors.secondary, fontSize: 15 * TEXT_SCALE_FACTORS[option] }}>Aa</Text>
              {option === scale ? <Text style={styles.rowAction}>Selected</Text> : null}
            </Pressable>
          ))}
        </SettingSection>
        <View style={styles.preview}>
          <Text style={[styles.previewBody, { fontSize: 16 * factor, lineHeight: 24 * factor }]}>The quick brown fox jumps over the lazy dog</Text>
          <View style={styles.previewCode}>
            <Text style={[styles.previewCodeText, { fontSize: 13 * factor, lineHeight: 21 * factor }]} selectable>{'const reply = await agent.run("summarize");'}</Text>
          </View>
        </View>

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
  const content = <><Text style={[styles.rowLabel, large && styles.rowLabelLarge]}>{label}</Text><Text style={[styles.rowValue, large && styles.rowValueLarge]} selectable>{value}</Text>{onPress ? <Text style={styles.rowAction}>Edit</Text> : null}</>;
  if (!onPress) return <View style={rowStyle}>{content}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${label}`} onPress={onPress} style={({ pressed }) => [rowStyle, { opacity: pressed ? 0.65 : 1 }]}>{content}</Pressable>;
}

const styles = StyleSheet.create({
  header: { minHeight: 62, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerSlot: { width: 44, alignItems: 'flex-start' },
  headerAction: { alignItems: 'flex-end' },
  headerTitle: { color: relayColors.primary, fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.25 },
  identity: { paddingTop: 24, paddingBottom: 18, gap: 7 },
  agentName: { color: relayColors.primary, fontSize: 30, lineHeight: 36, fontWeight: '600', paddingTop: 6 },
  hostname: { color: relayColors.secondary, fontSize: 13 },
  section: { paddingTop: 22, gap: 8 },
  sectionLabel: { color: relayColors.primary, fontSize: 14, fontWeight: '600' },
  rows: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: relayColors.line },
  row: { minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: relayColors.line, flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowLarge: { flexDirection: 'column', alignItems: 'stretch', gap: 6, paddingVertical: 12 },
  rowLabel: { color: relayColors.primary, fontSize: 17, lineHeight: 23, flexShrink: 0 },
  rowLabelLarge: { flexShrink: 1 },
  rowValue: { color: relayColors.secondary, fontSize: 17, lineHeight: 23, flex: 1, textAlign: 'right' },
  rowValueLarge: { flex: 0, textAlign: 'left', alignSelf: 'stretch' },
  rowAction: { color: relayColors.cyan, fontSize: 15, lineHeight: 20, fontWeight: '600' },
  primaryAction: { paddingTop: 8 },
  testConnection: { minHeight: 44, justifyContent: 'center' }, testConnectionText: { color: relayColors.cyan, fontSize: 15 },
  preview: { paddingTop: 14, gap: 10 },
  previewBody: { color: relayColors.primary },
  // Mirrors the message-content codeBlock so the preview matches thread text.
  previewCode: { backgroundColor: '#151517', borderRadius: 8, padding: 14 },
  previewCodeText: { color: '#e8e8ed', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  dangerSection: { paddingTop: 28, gap: 10 },
  dangerHelp: { color: relayColors.muted, fontSize: 12, lineHeight: 17, paddingTop: 2, maxWidth: 330 },
});
