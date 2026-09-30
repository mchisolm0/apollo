import { Text } from 'react-native';
import type { MarkdownStyle } from 'react-native-enriched-markdown';
import { useColors, useTextScale } from '../relay/relay-ui';

// Keep content readable if a development client predates the native renderer.
export function FallbackMarkdown({ markdown }: { markdown: string; markdownStyle: MarkdownStyle; onLinkPress: (link: { url: string }) => void }) {
  const { factor } = useTextScale();
  return <Text selectable style={{ color: useColors().primary, fontSize: 16 * factor, lineHeight: 24 * factor }}>{markdown}</Text>;
}
