import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';

import { relayColors, useColors, useRelayTheme, RelaySlider, CODE_SIZE_MAX, CODE_SIZE_MIN, TEXT_SIZE_MAX, TEXT_SIZE_MIN, useTextScale, styles as uiStyles } from './relay-ui';
import { SettingRow, SettingSection, SettingsHeader, settingStyles } from './settings-ui';
import { THEMES, type ThemeId } from './theme';

/** App-wide, local-only preferences: theme, text and code size, plus build info. Agent details live on the agent screen. */
export function AppSettingsScreen({ onBack }: { onBack?: () => void }) {
  const { pt, factor, setSize, codeSize, codeCustom, setCodeCustom, setCodeSize } = useTextScale();
  const { id: themeId, setTheme } = useRelayTheme();
  const colors = useColors();
  const { fontScale } = useWindowDimensions();
  const large = fontScale > 1.3;
  const monoSize = codeCustom ? codeSize : 13 * factor;
  return (
    <View style={uiStyles.screen}>
      <SettingsHeader title="Settings" onBack={onBack} />
      <ScrollView contentContainerStyle={uiStyles.content}>
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
          <View style={[settingStyles.row, large && styles.rowLarge]}>
            <Text style={styles.sizeGlyphSmall}>AA</Text>
            <Text style={settingStyles.rowLabel}>Text size</Text>
            <Text style={settingStyles.rowValue}>{pt} pt</Text>
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

        <SettingSection label="Code">
          <View style={styles.terminal}>
            <Text style={[styles.terminalLine, { color: colors.green, fontSize: monoSize, lineHeight: monoSize + 6 }]}>{'$ ekho status'}</Text>
            <Text style={[styles.terminalLine, { color: colors.primary, fontSize: monoSize, lineHeight: monoSize + 6 }]}>{'agent: luna · connected'}</Text>
            <Text style={[styles.terminalLine, { color: colors.amber, fontSize: monoSize, lineHeight: monoSize + 6 }]}>{'⟳ run 4f2a · streaming…'}</Text>
            <Text style={[styles.terminalLine, { color: colors.muted, fontSize: monoSize, lineHeight: monoSize + 6 }]}>{'# done in 1.2s'}</Text>
          </View>
          <View style={settingStyles.row}>
            <Text style={settingStyles.rowLabel}>Custom font size</Text>
            <View style={styles.spacer} />
            <Switch
              value={codeCustom}
              onValueChange={(next) => void setCodeCustom(next)}
              trackColor={{ true: colors.cyan, false: relayColors.lineStrong }}
              thumbColor={colors.primary}
            />
          </View>
          {codeCustom ? (
            <>
              <View style={settingStyles.row}>
                <Text style={settingStyles.rowLabel}>Code size</Text>
                <Text style={settingStyles.rowValue}>{codeSize} pt</Text>
              </View>
              <RelaySlider min={CODE_SIZE_MIN} max={CODE_SIZE_MAX} value={codeSize} label="Code size" onChange={(next) => void setCodeSize(next)} />
            </>
          ) : null}
        </SettingSection>

        <SettingSection label="App">
          <SettingRow label="Version" value={Constants.expoConfig?.version ?? 'Unknown'} />
          <SettingRow label="Fingerprint" value={Updates.runtimeVersion ?? 'Unavailable in development'} />
        </SettingSection>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  rowLarge: { flexWrap: 'wrap' },
  spacer: { flex: 1 },
  sizeGlyphSmall: { color: relayColors.secondary, fontSize: 13, fontWeight: '600' },
  sizeGlyphLarge: { color: relayColors.primary, fontSize: 22, fontWeight: '600' },
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
});
