import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ConnectionMark, connectionLabels, RelayButton, RelayInput, useColors, useRelayStyles, useThemedStyles, type RelayPalette } from './relay-ui';
import { SettingRow, SettingSection, SettingsHeader } from './settings-ui';
import type { RelayAgent } from './types';

export type AgentSettingsScreenProps = {
  agent: RelayAgent;
  deviceName: string;
  pairedAt?: string;
  onBack?: () => void;
  onTestConnection?: () => Promise<void>;
  connectionError?: string;
  onRename?: (name: string) => Promise<void>;
  onForgetAgent?: () => void;
  onNotifications?: () => void;
  onToolsets?: () => void;
  defaultModel?: string;
  platform?: string;
  /** Cloud inbox status for this phone; `onPress` sets it up or reconnects. */
  cloudInbox?: { value: string; action?: string; onPress?: () => void };
};

/** One agent's connection and pairing details, opened from the agent picker. App-wide preferences live in AppSettingsScreen. */
export function AgentSettingsScreen({ agent, deviceName, pairedAt, onBack, onTestConnection, connectionError, onRename, onForgetAgent, onNotifications, onToolsets, defaultModel, platform, cloudInbox }: AgentSettingsScreenProps) {
  const styles = useThemedStyles(createStyles);
  const uiStyles = useRelayStyles();
  const colors = useColors();
  const agentPlatform = platform ?? agent.platform;
  const [name, setName] = useState(agent.name);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [testError, setTestError] = useState<string>();
  const saveName = async () => {
    if (!onRename || savingName || !name.trim() || name.trim() === agent.name) return;
    setSavingName(true);
    setNameError(undefined);
    try {
      await onRename(name.trim());
      setName(name.trim());
    } catch (error) {
      setNameError(error instanceof Error ? error.message : 'Could not save name.');
    } finally {
      setSavingName(false);
    }
  };
  const testConnection = async () => {
    if (!onTestConnection || testing) return;
    setTesting(true);
    setTestError(undefined);
    try {
      await onTestConnection();
    } catch (error) {
      setTestError(error instanceof Error ? error.message : 'Could not connect.');
    } finally {
      setTesting(false);
      setTested(true);
    }
  };
  const testFailed = Boolean(testError) || agent.connection !== 'connected';
  return (
    <View style={uiStyles.screen}>
      <SettingsHeader title="Agent" onBack={onBack} />
      <ScrollView contentContainerStyle={uiStyles.content}>
        <View style={styles.identity}>
          <ConnectionMark state={agent.connection} label />
          {onRename ? <View style={styles.nameEditor}>
            <RelayInput accessibilityLabel="Agent name" value={name} onChangeText={setName} editable={!savingName} autoCorrect={false} style={styles.nameInput} returnKeyType="done" onSubmitEditing={() => void saveName()} />
            <RelayButton compact disabled={savingName || !name.trim() || name.trim() === agent.name} onPress={() => void saveName()}>{savingName ? 'Saving…' : 'Save'}</RelayButton>
          </View> : <Text style={styles.agentName}>{agent.name}</Text>}
          {nameError ? <Text accessibilityRole="alert" style={[styles.result, { color: colors.red }]}>{nameError}</Text> : null}
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
        {onTestConnection ? <View style={styles.primaryAction}>
          <Pressable accessibilityRole="button" disabled={testing} onPress={() => void testConnection()} style={styles.testConnection}><Text style={[styles.testConnectionText, { color: colors.cyan }]}>{testing ? 'Testing…' : 'Test connection'}</Text></Pressable>
          {tested && !testing ? <Text accessibilityLiveRegion="polite" accessibilityRole={testFailed ? 'alert' : undefined} style={[styles.result, { color: testFailed ? colors.red : colors.secondary }]}>{testError ?? (testFailed ? connectionError ?? connectionLabels[agent.connection] : 'Connected')}</Text> : null}
        </View> : null}

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
  nameEditor: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  nameInput: { flex: 1 },
  primaryAction: { paddingTop: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  result: { fontSize: 13, flexShrink: 1 },
  testConnection: { minHeight: 44, justifyContent: 'center' }, testConnectionText: { fontSize: 15 },
  dangerSection: { paddingTop: 28, gap: 10 },
  dangerHelp: { color: colors.muted, fontSize: 12, lineHeight: 17, paddingTop: 2, maxWidth: 330 },
});
