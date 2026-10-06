import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { RelayButton, RelayHeader, RelayInput, useRelayStyles, useThemedStyles, type RelayPalette } from './relay-ui';
import type { PairingMode, PairingPayload, PairingState, QrContent } from './types';

export type PairingScreenProps = {
  pairing?: PairingPayload;
  initialMode?: PairingMode;
  state?: PairingState;
  isBusy?: boolean;
  errorMessage?: string;
  qrContent?: QrContent;
  onBack?: () => void;
  onCancel?: () => void;
  onModeChange?: (mode: PairingMode) => void;
  onManualSubmit: (value: string) => void;
  onConfirm: (pairing: PairingPayload) => void;
  onRetry?: () => void;
};

/** Identity confirmation stays separate from exchanging the one-time pairing link. */
export function PairingScreen({ pairing, initialMode = 'qr', state = 'ready', isBusy = false, errorMessage, qrContent, onBack, onCancel, onModeChange, onManualSubmit, onConfirm, onRetry }: PairingScreenProps) {
  const styles = useThemedStyles(createStyles);
  const uiStyles = useRelayStyles();
  const scroll = useRef<ScrollView>(null);
  const failed = state === 'expired' || state === 'error' || state === 'confirm' && !pairing;
  useEffect(() => {
    if (failed) { Keyboard.dismiss(); scroll.current?.scrollTo({ y: 0, animated: true }); }
  }, [failed]);
  const [mode, setMode] = useState<PairingMode>(initialMode);
  const [manualValue, setManualValue] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const changeMode = (next: PairingMode) => { setMode(next); onModeChange?.(next); };
  const confirming = state === 'confirm' && pairing;
  const submit = () => { if (manualValue.trim() && !isBusy) onManualSubmit(manualValue.trim()); };
  return <KeyboardAvoidingView style={uiStyles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <RelayHeader title={confirming ? 'Confirm agent' : 'Add agent'} onBack={isBusy ? undefined : confirming ? onCancel ?? onBack : onBack} />
    <ScrollView ref={scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      {failed ? <View style={styles.error} accessibilityRole="alert">
        <Text style={styles.errorTitle}>{state === 'expired' ? 'Pairing link expired' : 'Could not connect'}</Text>
        <Text style={styles.helper}>{state === 'expired' ? 'Generate a new code from the connector and try again.' : errorMessage ?? 'Scan or paste the pairing link again.'}</Text>
        {onRetry ? <RelayButton disabled={isBusy} onPress={onRetry}>Try again</RelayButton> : null}
      </View> : null}
      {confirming ? <>
        <Text accessibilityRole="header" style={styles.title}>{pairing.machineName ?? 'Hermes'}</Text>
        <Text style={styles.intro}>Check that this is your agent before connecting.</Text>
        <View style={styles.details}>
          <DetailRow label="Hostname" value={pairing.hostname} />
          <DetailRow label="Address" value={pairing.endpoint} />
          <DetailRow label="Connection" value={pairing.transport === 'tailscale' ? 'Tailscale' : pairing.endpoint.startsWith('http:') ? 'Local development' : 'HTTPS'} />
        </View>
        <Text style={styles.helper}>This phone gets its own access. You can remove it later.</Text>
        <RelayButton tone="primary" disabled={isBusy} onPress={() => onConfirm(pairing)}>{isBusy ? 'Connecting…' : 'Connect agent'}</RelayButton>
      </> : <>
        <Text accessibilityRole="header" style={styles.title}>Connect to{ '\n' }your Hermes.</Text>
        <Text style={styles.intro}>{mode === 'qr' ? 'Open the connector on your computer, then scan its pairing code.' : 'Paste the one-time pairing link from your connector.'}</Text>
        {mode === 'qr' ? <>
          <View style={styles.camera} accessibilityLabel={qrContent ? 'Pairing camera preview' : 'Camera unavailable'}>{qrContent ?? <Text style={styles.cameraHelp}>Camera unavailable here.{ '\n' }Use a pairing link.</Text>}</View>
          <RelayButton tone="primary" disabled={isBusy} onPress={() => changeMode('manual')}>{isBusy ? 'Checking agent…' : 'Paste pairing link'}</RelayButton>
        </> : <View style={styles.manual}>
          <Text style={styles.fieldLabel}>Pairing link</Text>
          <RelayInput autoCapitalize="none" autoCorrect={false} autoFocus={!failed} editable={!isBusy} value={manualValue} onChangeText={setManualValue} placeholder="apollo://pair…" accessibilityLabel="Pairing link" onSubmitEditing={submit} returnKeyType="go" />
          <RelayButton tone="primary" disabled={!manualValue.trim() || isBusy} onPress={submit}>{isBusy ? 'Checking agent…' : 'Review agent'}</RelayButton>
          <Pressable accessibilityRole="button" disabled={isBusy} onPress={() => changeMode('qr')} style={styles.inline}><Text style={styles.link}>Scan a code instead</Text></Pressable>
        </View>}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showHelp }} onPress={() => setShowHelp(!showHelp)} style={styles.helpToggle}><Text style={styles.helpTitle}>{showHelp ? '⌄' : '›'} Where do I get a code?</Text></Pressable>
        {showHelp ? <Text style={styles.helper}>On the computer running Hermes, run your Apollo connector pairing command. Keep both devices on your private network.</Text> : null}
        <Text style={styles.helper}>You will review the agent name and address before connecting.</Text>
      </>}

    </ScrollView>
  </KeyboardAvoidingView>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(createStyles);
  return <View style={styles.detailRow}><Text style={styles.detailLabel}>{label}</Text><Text selectable style={styles.detailValue}>{value}</Text></View>;
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 28, gap: 16 },
  title: { color: colors.primary, fontSize: 32, lineHeight: 38, fontWeight: '600', letterSpacing: -0.8 },
  intro: { color: colors.primary, fontSize: 16, lineHeight: 24 },
  camera: { width: 230, height: 230, marginVertical: 20, alignSelf: 'center', borderWidth: 1, borderColor: colors.lineStrong, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  cameraHelp: { color: colors.secondary, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  helper: { color: colors.secondary, fontSize: 14, lineHeight: 21 },
  manual: { gap: 14, paddingTop: 16 }, fieldLabel: { color: colors.primary, fontSize: 14 },
  inline: { minHeight: 44, justifyContent: 'center', alignItems: 'center' }, link: { color: colors.cyan, fontSize: 14 },
  helpToggle: { minHeight: 48, justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, marginTop: 10 }, helpTitle: { color: colors.primary, fontSize: 14 },
  details: { marginVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  detailRow: { paddingVertical: 14, gap: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  detailLabel: { color: colors.secondary, fontSize: 13 }, detailValue: { color: colors.primary, fontSize: 16, lineHeight: 23 },
  error: { borderLeftWidth: 2, borderLeftColor: colors.amber, paddingLeft: 14, gap: 12, marginTop: 12 }, errorTitle: { color: colors.amber, fontSize: 16, fontWeight: '600' },
});
