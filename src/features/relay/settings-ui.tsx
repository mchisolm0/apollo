import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { IconButton, useColors, useTextScale, useThemedStyles, type RelayPalette } from './relay-ui';
import { isLargeText } from './text-size';

/** Pushed-screen header shared by app and agent settings: back chevron, centered title. */
/** Centered settings title; `detail` names the subject (e.g. the agent) on its own line so it never truncates away. */
export function SettingsHeader({ title, detail, onBack }: { title: string; detail?: string; onBack?: () => void }) {
  const styles = useThemedStyles(createStyles);
  const { factor } = useTextScale();
  return (
    <View style={styles.header}>
      <View style={styles.headerSlot}>{onBack ? <IconButton name="chevron.left" label="Back" onPress={onBack} /> : null}</View>
      <View style={styles.headerText}>
        <Text style={[styles.headerTitle, { fontSize: 17 * factor, lineHeight: 22 * factor }]} numberOfLines={1}>{title}</Text>
        {detail ? <Text style={[styles.headerDetail, { fontSize: 13 * factor, lineHeight: 17 * factor }]} numberOfLines={1}>{detail}</Text> : null}
      </View>
      <View style={styles.headerSlot} />
    </View>
  );
}

export function SettingSection({ label, children }: { label: string; children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  const { factor } = useTextScale();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionLabel, { fontSize: 14 * factor }]}>{label}</Text>
      <View style={styles.rows}>{children}</View>
    </View>
  );
}

export function SettingRow({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  const styles = useThemedStyles(createStyles);
  const settingStyles = useSettingStyles();
  const { fontScale } = useWindowDimensions();
  const { factor } = useTextScale();
  const cyan = useColors().cyan;
  const large = isLargeText(fontScale, factor);
  const rowStyle = [settingStyles.row, large && styles.rowLarge];
  const content = <><Text style={[settingStyles.rowLabel, large && styles.rowLabelLarge]}>{label}</Text><Text style={[settingStyles.rowValue, large && styles.rowValueLarge]} selectable>{value}</Text>{onPress ? <Text style={[styles.rowAction, { color: cyan, fontSize: 15 * factor, lineHeight: 20 * factor }]}>Edit</Text> : null}</>;
  if (!onPress) return <View style={rowStyle}>{content}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${label}`} onPress={onPress} style={({ pressed }) => [rowStyle, { opacity: pressed ? 0.65 : 1 }]}>{content}</Pressable>;
}

/** Row styles for custom rows (sliders, switches) that sit alongside SettingRow. */
const createSettingStyles = (colors: RelayPalette) => StyleSheet.create({
  row: { minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, paddingTop: 12, paddingHorizontal: 0 },
  rowLabel: { color: colors.primary, fontSize: 17, lineHeight: 23, flexShrink: 1 },
  rowValue: { color: colors.secondary, fontSize: 17, lineHeight: 23, flex: 1, textAlign: 'right' },
});

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  header: { backgroundColor: colors.chrome, minHeight: 62, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerSlot: { width: 44, alignItems: 'flex-start' },
  headerText: { flex: 1 },
  headerDetail: { textAlign: 'center', color: colors.secondary },
  headerTitle: { textAlign: 'center', color: colors.primary, fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.25 },
  section: { paddingTop: 22, gap: 8 },
  sectionLabel: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  rows: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, gap: 10, paddingBottom: 6 },
  rowLarge: { flexDirection: 'column', alignItems: 'stretch', gap: 6, paddingVertical: 12 },
  rowLabelLarge: { flexShrink: 1 },
  rowValueLarge: { flex: 0, textAlign: 'left', alignSelf: 'stretch' },
  rowAction: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
});

export function useSettingStyles() {
  const styles = useThemedStyles(createSettingStyles);
  const { factor } = useTextScale();
  return {
    ...styles,
    rowLabel: { ...styles.rowLabel, fontSize: 17 * factor, lineHeight: 23 * factor },
    rowValue: { ...styles.rowValue, fontSize: 17 * factor, lineHeight: 23 * factor },
  };
}
