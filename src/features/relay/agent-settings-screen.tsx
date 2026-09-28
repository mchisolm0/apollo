import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import type { ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';

import { ConnectionAction, ConnectionMark, connectionLabels, IconButton, RelayButton, relayColors, useColors, useRelayTheme, RelaySlider, CODE_SIZE_MAX, CODE_SIZE_MIN, TEXT_SIZE_MAX, TEXT_SIZE_MIN, useTextScale, styles as uiStyles } from './relay-ui';
import { THEMES, type ThemeId } from './theme';
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

export function AgentSettingsScreen({ agent, deviceName = 'This device', environmentCount, pairedAt, onBack, onTestConnection, onEditEndpoint, onRevokeDevice, onForgetAgent }: AgentSettingsScreenProps) {
  const { pt, factor, setSize, codeSize, codeCustom, setCodeCustom, setCodeSize } = useTextScale();
  const { id: themeId, setTheme } = useRelayTheme();
  const colors = useColors();
  const { fontScale } = useWindowDimensions();
  const large = fontScale > 1.3;
  const monoSize = codeCustom ? codeSize : 13 * factor;
  return (
    <View style={uiStyles.screen}>
      <View style={styles.header}>
        <View style={styles.headerSlot}>{onBack ? <IconButton name="chevron.left" label="Back" onPress={onBack} /> : null}</View>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.headerSlot} />
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
        {onTestConnection ? <View style={styles.primaryAction}><Pressable accessibilityRole="button" onPress={onTestConnection} style={styles.testConnection}><Text style={[styles.testConnectionText, { color: colors.cyan }]}>Test connection</Text></Pressable></View> : null}

        <SettingSection label="Appearance">
          <View style={styles.themeRow}>
            {THEMES.map((theme) => (
              <Pressable
                key={theme.id}
                accessibilityRole="button"
                accessibilityLabel={`${theme.label} theme`}
                accessibilityState={{ selected: themeId === theme.id }}
                onPress={() => void setTheme(theme.id as ThemeId)}
                style={[styles.themeChip, themeId === theme.id && { borderColor: colors.cyan, borderWidth: 2, padding: 5 }]}
              >
                <View style={[styles.themeDot, { backgroundColor: theme.accent }]} />
                <Text style={styles.themeChipLabel}>{theme.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={[styles.row, large && styles.rowLarge]}>
            <Text style={styles.sizeGlyphSmall}>AA</Text>
            <Text style={[styles.rowLabel, large && styles.rowLabelLarge]}>Text size</Text>
            <Text style={[styles.rowValue, large && styles.rowValueLarge]}>{pt} pt</Text>
            <Text style={styles.sizeGlyphLarge}>A</Text>
          </View>
          <RelaySlider min={TEXT_SIZE_MIN} max={TEXT_SIZE_MAX} value={pt} label="Text size" onChange={(next) => void setSize(next)} />
          <View style={styles.preview}>
            <Text style={[styles.previewBody, { fontSize: 16 * factor, lineHeight: 24 * factor }]}>The quick brown fox jumps over the lazy dog.</Text>
            <Text style={[styles.previewBody, styles.previewSecondary, { fontSize: 16 * factor, lineHeight: 24 * factor }]}>Messages, labels, and headings scale with this size.</Text>
            <View style={styles.previewCode}>
              <Text style={[styles.previewCodeText, { fontSize: monoSize, lineHeight: monoSize + 8 }]} selectable>{'const reply = await agent.run("summarize");'}</Text>
            </View>
          </View>
        </SettingSection>

        <SettingSection label="Terminal">
          <View style={styles.terminal}>
            <Text style={[styles.terminalLine, { color: colors.green, fontSize: monoSize, lineHeight: monoSize + 6 }]}>{'$ ekho status'}</Text>
            <Text style={[styles.terminalLine, { color: colors.primary, fontSize: monoSize, lineHeight: monoSize + 6 }]}>{'agent: luna · connected'}</Text>
            <Text style={[styles.terminalLine, { color: colors.amber, fontSize: monoSize, lineHeight: monoSize + 6 }]}>{'⟳ run 4f2a · streaming…'}</Text>
            <Text style={[styles.terminalLine, { color: colors.muted, fontSize: monoSize, lineHeight: monoSize + 6 }]}>{'# done in 1.2s'}</Text>
          </View>
          <View style={[styles.row, styles.terminalToggle]}>
            <Text style={styles.rowLabel}>Custom font size</Text>
            <Switch
              value={codeCustom}
              onValueChange={(next) => void setCodeCustom(next)}
              trackColor={{ true: colors.cyan, false: relayColors.lineStrong }}
              thumbColor={colors.primary}
            />
          </View>
          {codeCustom ? (
            <>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Code size</Text>
                <Text style={styles.rowValue}>{codeSize} pt</Text>
              </View>
              <RelaySlider min={CODE_SIZE_MIN} max={CODE_SIZE_MAX} value={codeSize} label="Code size" onChange={(next) => void setCodeSize(next)} />
            </>
          ) : null}
        </SettingSection>

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
  const cyan = useColors().cyan;
  const large = fontScale > 1.3;
  const rowStyle = [styles.row, large && styles.rowLarge];
  const content = <><Text style={[styles.rowLabel, large && styles.rowLabelLarge]}>{label}</Text><Text style={[styles.rowValue, large && styles.rowValueLarge]} selectable>{value}</Text>{onPress ? <Text style={[styles.rowAction, { color: cyan }]}>Edit</Text> : null}</>;
  if (!onPress) return <View style={rowStyle}>{content}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${label}`} onPress={onPress} style={({ pressed }) => [rowStyle, { opacity: pressed ? 0.65 : 1 }]}>{content}</Pressable>;
}

const styles = StyleSheet.create({
  header: { minHeight: 62, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerSlot: { width: 44, alignItems: 'flex-start' },
  headerTitle: { color: relayColors.primary, fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.25 },
  identity: { paddingTop: 24, paddingBottom: 18, gap: 7 },
  agentName: { color: relayColors.primary, fontSize: 30, lineHeight: 36, fontWeight: '600', paddingTop: 6 },
  hostname: { color: relayColors.secondary, fontSize: 13 },
  section: { paddingTop: 22, gap: 8 },
  sectionLabel: { color: relayColors.primary, fontSize: 14, fontWeight: '600' },
  rows: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: relayColors.line, gap: 10, paddingBottom: 6 },
  row: { minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: relayColors.line, flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 12, paddingHorizontal: 0 },
  rowLarge: { flexDirection: 'column', alignItems: 'stretch', gap: 6, paddingVertical: 12 },
  rowLabel: { color: relayColors.primary, fontSize: 17, lineHeight: 23, flexShrink: 0 },
  rowLabelLarge: { flexShrink: 1 },
  rowValue: { color: relayColors.secondary, fontSize: 17, lineHeight: 23, flex: 1, textAlign: 'right' },
  rowValueLarge: { flex: 0, textAlign: 'left', alignSelf: 'stretch' },
  rowAction: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  sizeGlyphSmall: { color: relayColors.secondary, fontSize: 13, fontWeight: '600' },
  sizeGlyphLarge: { color: relayColors.primary, fontSize: 22, fontWeight: '600' },
  primaryAction: { paddingTop: 8 },
  testConnection: { minHeight: 44, justifyContent: 'center' }, testConnectionText: { fontSize: 15 },
  themeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 10 },
  themeChip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 36, borderRadius: 10, borderWidth: 1, borderColor: relayColors.line, backgroundColor: relayColors.surface },

  themeChipLabel: { color: relayColors.primary, fontSize: 14 },
  themeDot: { width: 12, height: 12, borderRadius: 6 },
  preview: { paddingTop: 14, gap: 10 },
  previewBody: { color: relayColors.primary },
  previewSecondary: { color: relayColors.secondary },
  // Mirrors the message-content codeBlock so the preview matches thread text.
  previewCode: { backgroundColor: '#151517', borderRadius: 8, padding: 14 },
  previewCodeText: { color: '#e8e8ed', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  terminal: { backgroundColor: '#151517', borderRadius: 8, padding: 14, gap: 6 },
  terminalLine: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 19 },
  terminalToggle: { borderTopWidth: 0 },
  dangerSection: { paddingTop: 28, gap: 10 },
  dangerHelp: { color: relayColors.muted, fontSize: 12, lineHeight: 17, paddingTop: 2, maxWidth: 330 },
});
