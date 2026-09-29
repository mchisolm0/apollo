import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { IconButton, relayColors, useColors } from './relay-ui';

/** Pushed-screen header shared by app and agent settings: back chevron, centered title. */
export function SettingsHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerSlot}>{onBack ? <IconButton name="chevron.left" label="Back" onPress={onBack} /> : null}</View>
      <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
      <View style={styles.headerSlot} />
    </View>
  );
}

export function SettingSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.rows}>{children}</View>
    </View>
  );
}

export function SettingRow({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  const { fontScale } = useWindowDimensions();
  const cyan = useColors().cyan;
  const large = fontScale > 1.3;
  const rowStyle = [settingStyles.row, large && styles.rowLarge];
  const content = <><Text style={[settingStyles.rowLabel, large && styles.rowLabelLarge]}>{label}</Text><Text style={[settingStyles.rowValue, large && styles.rowValueLarge]} selectable>{value}</Text>{onPress ? <Text style={[styles.rowAction, { color: cyan }]}>Edit</Text> : null}</>;
  if (!onPress) return <View style={rowStyle}>{content}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${label}`} onPress={onPress} style={({ pressed }) => [rowStyle, { opacity: pressed ? 0.65 : 1 }]}>{content}</Pressable>;
}

/** Row styles for custom rows (sliders, switches) that sit alongside SettingRow. */
export const settingStyles = StyleSheet.create({
  row: { minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: relayColors.line, flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 12, paddingHorizontal: 0 },
  rowLabel: { color: relayColors.primary, fontSize: 17, lineHeight: 23, flexShrink: 0 },
  rowValue: { color: relayColors.secondary, fontSize: 17, lineHeight: 23, flex: 1, textAlign: 'right' },
});

const styles = StyleSheet.create({
  header: { minHeight: 62, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerSlot: { width: 44, alignItems: 'flex-start' },
  headerTitle: { flex: 1, textAlign: 'center', color: relayColors.primary, fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.25 },
  section: { paddingTop: 22, gap: 8 },
  sectionLabel: { color: relayColors.primary, fontSize: 14, fontWeight: '600' },
  rows: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: relayColors.line, gap: 10, paddingBottom: 6 },
  rowLarge: { flexDirection: 'column', alignItems: 'stretch', gap: 6, paddingVertical: 12 },
  rowLabelLarge: { flexShrink: 1 },
  rowValueLarge: { flex: 0, textAlign: 'left', alignSelf: 'stretch' },
  rowAction: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
});
