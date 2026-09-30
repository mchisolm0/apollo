import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown';

export function FallbackMarkdown(props: { markdown: string; markdownStyle: MarkdownStyle; onLinkPress: (link: { url: string }) => void }) {
  return <EnrichedMarkdownText {...props} flavor="github" selectable />;
}
