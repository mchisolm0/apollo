import { memo, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import Prism from 'prismjs';
import 'prismjs/components/prism-perl';

import { useColors, useThemedStyles, type RelayPalette, useTextScale } from './relay-ui';

function tokens(value: string | Prism.Token | (string | Prism.Token)[], palette: RelayPalette): ReactNode {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((token, index) => <Text key={index}>{tokens(token, palette)}</Text>);
  const syntax: Record<string, string> = { keyword: palette.cyan, string: palette.green, number: palette.amber, comment: palette.muted, function: palette.cyan, regex: palette.green, variable: palette.cyan, operator: palette.cyan };
  return <Text style={{ color: syntax[value.type] ?? palette.codeText }}>{tokens(value.content, palette)}</Text>;
}

/** The native renderer has no Perl grammar. Only these blocks use Prism. */
export const PerlCode = memo(function PerlCode({ code }: { code: string }) {
  const colors = useColors();
  const styles = useThemedStyles(createStyles);
  const { factor, codePt } = useTextScale();
  return <View style={styles.block}>
    <Text style={[styles.label, { fontSize: 12 * factor }]}>Perl</Text>
    <ScrollView horizontal accessibilityLabel="Perl code"><Text selectable style={[styles.code, { fontSize: codePt, lineHeight: Math.round(codePt * 21 / 13) }]}>{tokens(Prism.tokenize(code, Prism.languages.perl), colors)}</Text></ScrollView>
  </View>;
});
const createStyles = (colors: RelayPalette) => StyleSheet.create({
  block: { backgroundColor: colors.codeBackground, borderRadius: 8, padding: 12, marginBottom: 16 },
  label: { color: colors.muted, fontSize: 12, marginBottom: 10 },
  code: { color: colors.codeText, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 21 },
});
