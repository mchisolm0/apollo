import { memo, useMemo } from 'react';
import { Alert, Linking, Platform } from 'react-native';
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown';

import { perlBlocks } from './perl-blocks';
import { PerlCode } from './perl-code';
import { relayColors as colors, useTextScale } from './relay-ui';

function openLink({ url }: { url: string }) {
  // Content may contain commands or app deep links. Only open normal web links.
  if (!/^https?:\/\//i.test(url)) {
    Alert.alert('Cannot open this link', 'Only HTTP and HTTPS links can be opened from a message.');
    return;
  }
  void Linking.openURL(url).catch(() => Alert.alert('Could not open link', 'Try again or copy the link from the message.'));
}

function markdownStyleFor(factor: number, codeSize: number): MarkdownStyle {
    const paragraph = { color: colors.primary, fontSize: 16 * factor, lineHeight: 24 * factor, marginTop: 0, marginBottom: 10 };
    return {
      paragraph,
      h1: { ...paragraph, fontSize: 24 * factor, lineHeight: 30 * factor, fontWeight: '600', marginTop: 12 },
      h2: { ...paragraph, fontSize: 21 * factor, lineHeight: 27 * factor, fontWeight: '600', marginTop: 12 },
      h3: { ...paragraph, fontSize: 18 * factor, fontWeight: '600' },
      h4: paragraph, h5: paragraph, h6: paragraph,
      list: { ...paragraph, bulletColor: colors.secondary, gapWidth: 8, itemSpacing: 6 },
      link: { color: colors.cyan, underline: true },
      code: { fontSize: Math.round(codeSize * 14 / 13), color: '#e8e8ed', backgroundColor: '#19191b', borderColor: '#19191b', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
      codeBlock: {
        color: '#e8e8ed', backgroundColor: '#151517',
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: codeSize, lineHeight: Math.round(codeSize * 21 / 13), padding: 14, borderRadius: 8,
        borderColor: '#151517', borderWidth: 0, marginBottom: 24,
        // Keep punctuation and identifiers neutral; color conveys token roles.
        syntaxColors: {
          keyword: '#b8abdc', string: '#a3c9a8', number: '#d5b58b',
          constant: '#d5b58b', comment: '#93939d', function: '#a5c4df',
          type: '#a5c4df', property: '#d0d0d7', tag: '#b8abdc',
          attribute: '#d5b58b', operator: '#e8e8ed', punctuation: '#d0d0d7',
          variable: '#e8e8ed', embedded: '#e8e8ed',
        },
      },
      blockquote: { ...paragraph, color: colors.secondary, borderColor: colors.lineStrong, borderWidth: 2, gapWidth: 12 },
      image: { maxHeight: 320, resizeMode: 'contain', borderRadius: 4 },
      thematicBreak: { color: colors.line },
    };
}

export const MessageContent = memo(function MessageContent({ text }: { text: string }) {
  const { factor, codePt } = useTextScale();
  const markdownStyle = useMemo(() => markdownStyleFor(factor, codePt), [factor, codePt]);
  return <>{perlBlocks(text).map((part, index) => part.kind === 'perl'
    ? <PerlCode key={index} code={part.text} />
    : <EnrichedMarkdownText key={index} markdown={part.text} markdownStyle={markdownStyle} flavor="github" selectable onLinkPress={openLink} containerStyle={{ backgroundColor: colors.background }} />)}</>;
});
