export type MarkdownPart = { kind: 'markdown' | 'perl'; text: string };

/** Recognize fences before selecting Perl, so examples inside other code stay intact. */
export function perlBlocks(text: string): MarkdownPart[] {
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/gm;
  const parts: MarkdownPart[] = [];
  let cursor = 0;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const fence = match[1];
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`, 'gm');
    close.lastIndex = opening.lastIndex;
    const ending = close.exec(text);
    const end = ending ? close.lastIndex : text.length;
    if (/^(perl|pl|pearl)$/i.test(match[2].trim())) {
      if (match.index > cursor) parts.push({ kind: 'markdown', text: text.slice(cursor, match.index) });
      parts.push({ kind: 'perl', text: text.slice(opening.lastIndex, ending?.index ?? text.length).replace(/\r?\n$/, '') });
      cursor = end;
    }
    opening.lastIndex = end;
  }
  if (cursor < text.length) parts.push({ kind: 'markdown', text: text.slice(cursor) });
  return parts;
}
