import Prism from 'prismjs';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-perl.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-typescript.js';

import type { MarkdownCodeHighlighter, MarkdownHighlightedToken } from '@ekho/native-markdown-text';

type HighlightColors = Readonly<{ cyan: string; green: string; amber: string; muted: string; codeText: string }>;

const aliases: Readonly<Record<string, string>> = { ts: 'typescript', js: 'javascript', jsx: 'javascript', shell: 'bash', sh: 'bash', html: 'markup' };

function flatten(stream: Prism.TokenStream, colors: HighlightColors, inherited?: Pick<MarkdownHighlightedToken, 'color' | 'fontStyle'>): MarkdownHighlightedToken[] {
  if (typeof stream === 'string') return [{ content: stream, color: inherited?.color ?? null, fontStyle: inherited?.fontStyle ?? null }];
  if (Array.isArray(stream)) return stream.flatMap((token) => flatten(token, colors, inherited));
  const tokenColors: Readonly<Record<string, string>> = {
    keyword: colors.cyan, builtin: colors.cyan, boolean: colors.amber, number: colors.amber,
    string: colors.green, char: colors.green, regex: colors.green, comment: colors.muted,
    function: colors.cyan, 'class-name': colors.cyan, variable: colors.cyan,
    operator: colors.cyan, property: colors.codeText, punctuation: colors.codeText,
  };
  return flatten(stream.content, colors, {
    color: tokenColors[stream.type] ?? inherited?.color ?? colors.codeText,
    fontStyle: stream.type === 'comment' ? 1 : stream.type === 'keyword' ? 2 : null,
  });
}

export function highlightCode(code: string, language: string | null | undefined, colors: HighlightColors): readonly (readonly MarkdownHighlightedToken[])[] {
  const name = aliases[language?.toLowerCase() ?? ''] ?? language?.toLowerCase() ?? '';
  const grammar = Prism.languages[name];
  const tokens = grammar ? flatten(Prism.tokenize(code, grammar), colors) : [{ content: code, color: null, fontStyle: null }];
  const lines: MarkdownHighlightedToken[][] = [[]];
  for (const token of tokens) {
    const parts = token.content.split('\n');
    parts.forEach((content, index) => {
      if (content) lines[lines.length - 1].push({ ...token, content });
      if (index < parts.length - 1) lines.push([]);
    });
  }
  return lines;
}

export function createPrismHighlighter(colors: HighlightColors): MarkdownCodeHighlighter {
  const highlighter = async ({ code, language }: { code: string; language?: string | null }) => highlightCode(code, language, colors);
  return Object.assign(highlighter, { cacheKey: [colors.cyan, colors.green, colors.amber, colors.muted, colors.codeText].join(':') });
}
