import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { GlassView } from 'expo-glass-effect';
import { AccessibilityInfo, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HAS_MAIL_TOOLBAR, MAIL_TOOLBAR_INSET } from '@/features/relay/mail-toolbar';
import { useColors } from '@/features/relay/relay-ui';
import { buildSummary } from './update-state';
import { useAppUpdate } from './update-provider';

function UpdateActions({ onInfo }: { onInfo(): void }) {
  const colors = useColors();
  const { restart, restarting } = useAppUpdate();
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="Update details" onPress={onInfo} style={styles.action}>
      <Text style={[styles.actionText, { color: colors.cyan }]}>ⓘ</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="Restart to update" disabled={restarting} accessibilityState={{ disabled: restarting }} onPress={() => void restart()} style={styles.action}>
      <Text style={[styles.actionText, { color: restarting ? colors.muted : colors.cyan }]}>{restarting ? 'Restarting' : 'Restart'}</Text>
    </Pressable>
  </>;
}

function UpdateDetails({ visible, onClose }: { visible: boolean; onClose(): void }) {
  const colors = useColors();
  const { state, restart, restarting, error } = useAppUpdate();
  if (state.status !== 'ready') return null;
  const { update } = state;
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <View style={[styles.backdrop, { backgroundColor: colors.background }]}>
      <View accessibilityViewIsModal style={[styles.dialog, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.primary }]}>Update ready</Text>
        <ScrollView style={styles.notes}>
          {update.notes.map((note, index) => <Text key={index} style={[styles.note, { color: colors.primary }]}>• {note}</Text>)}
          <Text selectable style={[styles.metadata, { color: colors.secondary }]}>{update.rollback ? 'Restore embedded update' : update.id}</Text>
          {update.createdAt ? <Text style={[styles.metadata, { color: colors.secondary }]}>{update.createdAt.toLocaleString()}</Text> : null}
          <Text style={[styles.metadata, { color: colors.secondary }]}>Restart to apply now, or wait for the app to go to the background. Drafts and sends are saved first.</Text>
          {error ? <Text accessibilityRole="alert" style={[styles.note, { color: colors.red }]}>{error}</Text> : null}
        </ScrollView>
        <View style={styles.dialogActions}>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.action}><Text style={[styles.actionText, { color: colors.secondary }]}>Later</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Restart to update" disabled={restarting} accessibilityState={{ disabled: restarting }} onPress={() => void restart()} style={styles.action}><Text style={[styles.actionText, { color: restarting ? colors.muted : colors.cyan }]}>{restarting ? 'Restarting' : 'Restart'}</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

// Height of the bottom dock: the native toolbar on iOS 26+, else the JS dock (44pt buttons, 8pt padding).
const DOCK_HEIGHT = HAS_MAIL_TOOLBAR ? MAIL_TOOLBAR_INSET : 60;
const DOCK_MARGIN = HAS_MAIL_TOOLBAR ? 16 : 12;

/**
 * "Update ready" floats just above the bottom dock as an overlay, so it never moves the list,
 * the dock or the safe area. Liquid Glass where available, the dock's surface elsewhere.
 */
export function UpdateReadyNotice() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { state, noticeVisible, dismissNotice, error } = useAppUpdate();
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (noticeVisible) AccessibilityInfo.announceForAccessibility('Update ready');
  }, [noticeVisible]);
  if (state.status !== 'ready') return null;
  return <>
    {noticeVisible ? <Animated.View
      entering={FadeInDown.duration(220)}
      exiting={FadeOutDown.duration(160)}
      pointerEvents="box-none"
      style={[styles.noticeLayer, { bottom: insets.bottom + DOCK_HEIGHT + 8, left: DOCK_MARGIN, right: DOCK_MARGIN }]}
    >
      {error ? <Text style={[styles.note, styles.noticeError, { color: colors.red, backgroundColor: colors.surface }]}>{error}</Text> : null}
      {HAS_MAIL_TOOLBAR
        ? <GlassView glassEffectStyle="regular" accessibilityLiveRegion="polite" style={[styles.notice, styles.noticeGlass]}>
          <Text style={[styles.noticeText, { color: colors.primary }]}>Update ready</Text>
          <UpdateActions onInfo={() => { dismissNotice(); setDetailsOpen(true); }} />
        </GlassView>
        : <View accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: colors.surface }]}>
          <Text style={[styles.noticeText, { color: colors.primary }]}>Update ready</Text>
          <UpdateActions onInfo={() => { dismissNotice(); setDetailsOpen(true); }} />
        </View>}
    </Animated.View> : null}
    <UpdateDetails visible={detailsOpen} onClose={() => setDetailsOpen(false)} />
  </>;
}

export function AppUpdateAbout() {
  const colors = useColors();
  const { state, running, error } = useAppUpdate();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const summary = buildSummary({
    version: Application.nativeApplicationVersion, build: Application.nativeBuildVersion,
    channel: running.channel, development: __DEV__, embedded: running.isEmbeddedLaunch,
    updateId: running.updateId, createdAt: running.createdAt,
  }, now);
  const progress = state.status === 'downloading' && state.progress !== undefined
    ? ` ${Math.round(Math.min(1, Math.max(0, state.progress)) * 100)}%` : '';
  return <View style={styles.about}>
    <Text selectable style={[styles.summary, { color: colors.primary }]}>{summary}</Text>
    <Text selectable style={[styles.fingerprint, { color: colors.muted }]}>Fingerprint {Updates.runtimeVersion ?? 'unavailable in development'}</Text>
    {state.status === 'checking' || state.status === 'downloading' ? <Text accessibilityLiveRegion="polite" style={[styles.metadata, { color: colors.secondary }]}>{state.status === 'checking' ? 'Checking for updates' : `Downloading update${progress}`}</Text> : null}
    {state.status === 'ready' ? <View style={[styles.statusRow, { borderColor: colors.line }]}>
      <Text style={[styles.noticeText, { color: colors.primary }]}>Update ready</Text>
      <UpdateActions onInfo={() => setDetailsOpen(true)} />
    </View> : null}
    {error ? <Text accessibilityRole="alert" style={[styles.note, { color: colors.red }]}>{error}</Text> : null}
    <UpdateDetails visible={detailsOpen} onClose={() => setDetailsOpen(false)} />
  </View>;
}

const styles = StyleSheet.create({
  about: { paddingVertical: 12, gap: 8 },
  summary: { fontSize: 14, lineHeight: 20 },
  fingerprint: { fontSize: 12, lineHeight: 17 },
  noticeLayer: { position: 'absolute', alignItems: 'center', gap: 6 },
  notice: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4, borderRadius: 8, maxWidth: 420, overflow: 'hidden' },
  noticeGlass: { borderRadius: 22 },
  noticeError: { borderRadius: 8, overflow: 'hidden', paddingHorizontal: 12, paddingVertical: 6, marginBottom: 0 },
  noticeText: { flexShrink: 1, fontSize: 15, lineHeight: 21 },
  action: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
  actionText: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  backdrop: { flex: 1, justifyContent: 'center', padding: 24 },
  dialog: { padding: 20, gap: 16, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, maxHeight: '80%', width: '100%', maxWidth: 480, alignSelf: 'center' },
  title: { fontSize: 19, lineHeight: 25, fontWeight: '600' },
  notes: { flexGrow: 0 },
  note: { fontSize: 15, lineHeight: 22, marginBottom: 8 },
  metadata: { fontSize: 12, lineHeight: 18, marginTop: 8 },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 12 },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
});
