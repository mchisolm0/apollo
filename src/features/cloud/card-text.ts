const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'about', 'blob']);

/** True for an absolute URL whose scheme can safely go to the system: http(s) or an app scheme. */
export function isOpenableUrl(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(url.trim())?.[1]?.toLowerCase();
  return scheme !== undefined && !BLOCKED_SCHEMES.has(scheme);
}

/**
 * One-line preview for a thread with no user message (a producer-written thread): the
 * latest assistant message, markdown stripped.
 */
export function latestAssistantPreview(messages: readonly { role: string; content?: string }[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.content) continue;
    const line = previewLine(message.content);
    if (line) return line;
  }
  return undefined;
}

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
