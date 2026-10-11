/**
 * The first readable line of a markdown body, for a one-line row preview: headings, list
 * and quote markers, emphasis, inline code, links and images are reduced to their text.
 */
export function previewLine(body: string | undefined): string | undefined {
  if (!body) return undefined;
  let fenced = false;
  for (const raw of body.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced || /^(?:-{3,}|\*{3,}|_{3,})$/u.test(trimmed)) continue;
    const line = trimmed
      .replace(/^#{1,6}\s+/u, '')
      .replace(/^>\s?/u, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/`([^`]+)`/gu, '$1')
      .replace(/(\*\*|__)(.+?)\1/gu, '$2')
      .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/gu, '$1')
      .replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/gu, '$1')
      .replace(/<[^>]+>/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
    if (line) return line;
  }
  return undefined;
}
