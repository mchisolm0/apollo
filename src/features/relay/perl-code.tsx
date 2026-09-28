import { memo, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import Prism from 'prismjs';
import 'prismjs/components/prism-perl';

import { useTextScale } from './relay-ui';

const colors: Record<string, string> = {
  keyword: '#b8abdc', string: '#a3c9a8', number: '#d5b58b', comment: '#93939d',
  function: '#a5c4df', regex: '#a3c9a8', variable: '#a5c4df', operator: '#b8abdc',
};
function tokens(value: string | Prism.Token | (string | Prism.Token)[]): ReactNode {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((token, index) => <Text key={index}>{tokens(token)}</Text>);
  return <Text style={{ color: colors[value.type] ?? '#e8e8ed' }}>{tokens(value.content)}</Text>;
}

/** The native renderer has no Perl grammar. Only these blocks use Prism. */
export const PerlCode = memo(function PerlCode({ code }: { code: string }) {
  const { factor, codePt } = useTextScale();
  return <View style={styles.block}>
    <Text style={[styles.label, { fontSize: 12 * factor }]}>Perl</Text>
    <ScrollView horizontal accessibilityLabel="Perl code"><Text selectable style={[styles.code, { fontSize: codePt, lineHeight: Math.round(codePt * 21 / 13) }]}>{tokens(Prism.tokenize(code, Prism.languages.perl))}</Text></ScrollView>
  </View>;
});
const styles = StyleSheet.create({
  block: { backgroundColor: '#151517', borderRadius: 8, padding: 12, marginBottom: 16 },
  label: { color: '#a1a1aa', fontSize: 12, marginBottom: 10 },
  code: { color: '#e8e8ed', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 21 },
});
