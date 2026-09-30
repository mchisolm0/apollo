import { SelectableMarkdownText, hasNativeSelectableMarkdownText, type NativeMarkdownTextStyle } from '@ekho/native-markdown-text';
import { memo, useMemo } from 'react';
import { Alert, Linking, Platform, StyleSheet, View } from 'react-native';
import type { MarkdownStyle } from 'react-native-enriched-markdown';
import { FallbackMarkdown } from '../content/fallback-markdown';

import { CopyButton } from '../content/copy-button';
import { splitDiffFences } from '../content/diff-parser';
import { hasNativeDiff, NativeDiff } from '../content/native-diff';
import { createPrismHighlighter } from '../content/prism-highlighter';
import { useColors, useTextScale } from './relay-ui';
import { perlBlocks } from './perl-blocks';
import { PerlCode } from './perl-code';

function openLink({ url }: { url: string }) {
  if (!/^https?:\/\//i.test(url)) {
    Alert.alert('Cannot open this link', 'Only HTTP and HTTPS links can be opened from a message.');
    return;
  }
  void Linking.openURL(url).catch(() => Alert.alert('Could not open link', 'Try again or copy the link from the message.'));
}

export const MessageContent = memo(function MessageContent({ text }: { text: string }) {
  const baseColors = useColors();
  const { factor, codePt } = useTextScale();
  const colors = useMemo(() => ({ ...baseColors, codeText: '#e8e8ed', codeBackground: '#151517' }), [baseColors]);
  const markdownStyle = useMemo<MarkdownStyle>(() => {
    const paragraph = { color: colors.primary, fontSize: 16 * factor, lineHeight: 24 * factor, marginTop: 0, marginBottom: 10 };
    return {
      paragraph,
      h1: { ...paragraph, fontSize: 24 * factor, lineHeight: 30 * factor, fontWeight: '600', marginTop: 12 },
      h2: { ...paragraph, fontSize: 21 * factor, lineHeight: 27 * factor, fontWeight: '600', marginTop: 12 },
      h3: { ...paragraph, fontSize: 18 * factor, fontWeight: '600' },
      h4: paragraph, h5: paragraph, h6: paragraph,
      list: { ...paragraph, bulletColor: colors.secondary, gapWidth: 8, itemSpacing: 6 },
      link: { color: colors.cyan, underline: true },
      code: { fontSize: Math.round(codePt * 14 / 13), color: colors.codeText, backgroundColor: colors.codeBackground, borderColor: colors.line, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
      codeBlock: {
        color: colors.codeText, backgroundColor: colors.codeBackground,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: codePt, lineHeight: Math.round(codePt * 21 / 13), padding: 14, borderRadius: 8,
        borderColor: colors.line, borderWidth: 1, marginBottom: 24,
        syntaxColors: {
          keyword: '#b8abdc', string: '#a3c9a8', number: '#d5b58b', constant: '#d5b58b',
          comment: colors.muted, function: '#a5c4df', type: '#a5c4df', property: colors.codeText,
          tag: '#b8abdc', attribute: '#d5b58b', operator: colors.codeText, punctuation: colors.secondary,
          variable: colors.codeText, embedded: colors.codeText,
        },
      },
      blockquote: { ...paragraph, color: colors.secondary, borderColor: colors.lineStrong, borderWidth: 2, gapWidth: 12 },
      image: { maxHeight: 320, resizeMode: 'contain', borderRadius: 4 },
      thematicBreak: { color: colors.line },
    };
  }, [colors, factor, codePt]);
  const nativeTextStyle = useMemo<NativeMarkdownTextStyle>(() => ({
    color: colors.primary, strongColor: colors.primary, mutedColor: colors.muted, linkColor: colors.cyan,
    inlineCodeColor: colors.codeText, codeColor: colors.codeText, codeBackgroundColor: colors.elevated,
    codeBlockBackgroundColor: colors.codeBackground, fileTextColor: colors.primary, skillTextColor: colors.primary,
    quoteMarkerColor: colors.lineStrong, dividerColor: colors.line, codeFontSize: codePt, fontSize: 16 * factor, lineHeight: 24 * factor,
    fontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif', headingFontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif',
    boldFontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif', headingFontSizes: [24, 21, 18, 16, 16, 16].map((size) => size * factor),
  }), [colors, factor, codePt]);
  const highlightCode = useMemo(() => createPrismHighlighter(colors), [colors]);

  const renderMarkdown = (value: string, key: string) => Platform.OS === 'ios' && hasNativeSelectableMarkdownText()
    ? <SelectableMarkdownText key={key} markdown={value} textStyle={nativeTextStyle} highlightCode={highlightCode} onLinkPress={(url) => openLink({ url })} marginBottom={4} />
    : <FallbackMarkdown key={key} markdown={value} markdownStyle={markdownStyle} onLinkPress={openLink} />;

  return <View style={styles.content}>
    <View style={styles.copy}><CopyButton text={text} /></View>
    {perlBlocks(text).flatMap((part, partIndex) => part.kind === 'perl'
      ? [<PerlCode key={`perl:${partIndex}`} code={part.text} />]
      : splitDiffFences(part.text).map((segment, segmentIndex) => segment.kind === 'diff' && hasNativeDiff()
        ? <NativeDiff key={`${partIndex}:${segmentIndex}`} patch={segment.text} />
        : renderMarkdown(segment.kind === 'diff' ? `\`\`\`diff\n${segment.text}\n\`\`\`` : segment.text, `${partIndex}:${segmentIndex}`)))}
  </View>;
});

const styles = StyleSheet.create({
  content: { position: 'relative', minWidth: 0 },
  copy: { height: 36, alignItems: 'flex-end' },
});
