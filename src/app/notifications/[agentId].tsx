import Constants from 'expo-constants';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { type NotificationPreferences, type NotificationRegistrationClient, useNotificationRegistration } from '@/features/notifications';
import { SettingSection, SettingsHeader, useSettingStyles } from '@/features/relay/settings-ui';
import { useEkho } from '@/lib';
import { useColors, useRelayStyles } from '@/features/relay/relay-ui';

const projectId = (Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId) as string | undefined;

export default function NotificationsRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const router = useRouter();
  const colors = useColors();
  const uiStyles = useRelayStyles();
  const { agents, notificationClient } = useEkho();
  const agent = agents.find((candidate) => candidate.id === agentId);
  const [client, setClient] = useState<NotificationRegistrationClient>();
  const [clientError, setClientError] = useState<string>();
  const reportError = useCallback((error: Error) => setClientError(error.message), []);

  useEffect(() => {
    let current = true;
    if (!agentId) return;
    void notificationClient(agentId).then((value) => { if (current) setClient(value); }).catch((cause: unknown) => {
      if (current) setClientError(cause instanceof Error ? cause.message : 'Could not connect to this agent.');
    });
    return () => { current = false; };
  }, [agentId, notificationClient]);

  const registration = useNotificationRegistration({
    client,
    projectId,
    onError: reportError,
  });
  if (!agent) return <Redirect href="/" />;
  const busy = registration.state === 'loading' || registration.state === 'enabling';
  const enabled = registration.state === 'enabled';
  const update = (key: keyof NotificationPreferences, value: boolean) => {
    void registration.enable({ ...registration.preferences, [key]: value });
  };

  return <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
    <SettingsHeader title="Notifications" detail={agent.label} onBack={() => router.back()} />
    <ScrollView contentContainerStyle={uiStyles.content}>
      {clientError ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.red }]}>{clientError}</Text> : null}
      <SettingSection label="This device">
        <Row label="Allow notifications">
          {busy ? <ActivityIndicator color={colors.secondary} /> : <Switch trackColor={{ true: colors.cyan, false: colors.lineStrong }} thumbColor={colors.primary} accessibilityLabel="Allow notifications" value={enabled} disabled={!client || registration.state === 'unsupported'} onValueChange={(value) => { setClientError(undefined); void (value ? registration.enable() : registration.disable()); }} />}
        </Row>
        <Text style={[styles.help, { color: colors.secondary }]}>{registration.state === 'denied' ? 'Notifications are disabled in system settings.' : registration.state === 'unsupported' ? 'Push notifications are unavailable on this device.' : 'Ekho sends short status updates without message or command text.'}</Text>
      </SettingSection>
      <SettingSection label="Notify me when">
        <Row label="Approval is needed"><Switch trackColor={{ true: colors.cyan, false: colors.lineStrong }} thumbColor={colors.primary} accessibilityLabel="Notify when approval is needed" disabled={!enabled || busy} value={registration.preferences.notifyOnApproval} onValueChange={(value) => update('notifyOnApproval', value)} /></Row>
        <Row label="A run finishes"><Switch trackColor={{ true: colors.cyan, false: colors.lineStrong }} thumbColor={colors.primary} accessibilityLabel="Notify when a run finishes" disabled={!enabled || busy} value={registration.preferences.notifyOnCompletion} onValueChange={(value) => update('notifyOnCompletion', value)} /></Row>
        <Row label="A run fails"><Switch trackColor={{ true: colors.cyan, false: colors.lineStrong }} thumbColor={colors.primary} accessibilityLabel="Notify when a run fails" disabled={!enabled || busy} value={registration.preferences.notifyOnFailure} onValueChange={(value) => update('notifyOnFailure', value)} /></Row>
      </SettingSection>
    </ScrollView>
  </SafeAreaView>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  const settingStyles = useSettingStyles();
  return <View style={settingStyles.row}><Text style={[settingStyles.rowLabel, styles.label]}>{label}</Text>{children}</View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  error: { fontSize: 13, paddingVertical: 12 },
  help: { fontSize: 13, lineHeight: 18, paddingTop: 10 },
  label: { flex: 1 },
});
