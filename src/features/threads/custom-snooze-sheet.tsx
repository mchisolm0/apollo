import { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { DateTimePicker } from '@expo/ui/community/datetime-picker';

import { useColors } from '@/features/relay/relay-ui';
import { customSnoozeUntil, resolveSnoozePresets } from '@/features/relay/snooze-presets';

const HOUR_MS = 60 * 60 * 1000;

/** T3's custom snooze, trimmed to its date-and-time mode. Rendered only while open. On Android it also lists the presets. */
export function CustomSnoozeSheet({ onClose, onSnooze }: { onClose: () => void; onSnooze: (until: number) => void }) {
  const colors = useColors();
  const [date, setDate] = useState(() => new Date(Date.now() + HOUR_MS));
  const [error, setError] = useState<string>();
  const [presets] = useState(() => Platform.OS === 'android' ? resolveSnoozePresets(new Date()) : []);
  const pick = (next: Date) => { setDate(next); setError(undefined); };
  // Android has no inline datetime picker, so it gets a date picker and a time picker; the time one only moves the clock.
  const pickTime = (next: Date) => { const merged = new Date(date); merged.setHours(next.getHours(), next.getMinutes(), 0, 0); pick(merged); };
  const submit = () => {
    const until = customSnoozeUntil(date, new Date());
    if (until === undefined) { setError('Choose a time in the future.'); return; }
    onSnooze(until);
  };
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <View style={[styles.backdrop, { backgroundColor: colors.backdrop }]}>
      <View accessibilityViewIsModal style={[styles.dialog, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.primary }]}>Snooze until</Text>
        {/* Android stacks presets and two Material pickers, taller than a phone; only the body scrolls. */}
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {presets.map((preset) => <Pressable key={preset.id} accessibilityRole="button" onPress={() => onSnooze(preset.until)} style={styles.preset}>
          <Text style={[styles.presetText, { color: colors.primary }]}>{preset.label}</Text>
          <Text style={[styles.presetText, { color: colors.secondary }]}>{preset.whenLabel}</Text>
        </Pressable>)}
        {Platform.OS === 'android' ? <>
          <DateTimePicker value={date} mode="date" presentation="inline" minimumDate={new Date()} accentColor={colors.cyan} themeVariant="dark" onValueChange={(_event, next) => pick(next)} />
          <DateTimePicker value={date} mode="time" presentation="inline" accentColor={colors.cyan} themeVariant="dark" onValueChange={(_event, next) => pickTime(next)} />
        </> : <DateTimePicker value={date} mode="datetime" display="inline" minimumDate={new Date()} accentColor={colors.cyan} themeVariant="dark" onValueChange={(_event, next) => pick(next)} />}
        </ScrollView>
        {error ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.red }]}>{error}</Text> : null}
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.action}><Text style={[styles.actionText, { color: colors.secondary }]}>Cancel</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={submit} style={styles.action}><Text style={[styles.actionText, { color: colors.cyan }]}>Snooze</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', padding: 24 },
  dialog: { padding: 20, gap: 16, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, width: '100%', maxWidth: 480, maxHeight: '100%', alignSelf: 'center' },
  body: { flexGrow: 0 }, bodyContent: { gap: 16 },
  title: { fontSize: 19, lineHeight: 25, fontWeight: '600' },
  error: { fontSize: 15, lineHeight: 22 },
  preset: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  presetText: { fontSize: 16, lineHeight: 22 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  action: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
  actionText: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
});
