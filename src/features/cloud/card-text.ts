/**
 * Schemes a card may open: the web, plus the app schemes producers link to today (Scryve
 * preview builds from the preview routine, and Apollo itself). Anything else, such as
 * `itms-services:`, `shortcuts:` or `tel:`, is refused.
 */
const OPENABLE_SCHEMES = new Set(['http', 'https', 'scryve', 'scryve-preview', 'scryve-dev', 'apollo', 'apollo-preview', 'apollo-dev']);

const APOLLO_SCHEMES = new Set(['apollo:', 'apollo-preview:', 'apollo-dev:']);
const ID = /^[A-Za-z0-9._~-]{1,256}$/u;

/** An Apollo link the app handles itself instead of handing to the system. */
export type ApolloLink =
  | { kind: 'session'; id: string; agentId: string }
  | { kind: 'invalid' };

/**
 * Reads an Apollo-scheme card link. `apollo://session/<threadId>?agentId=<agentId>` opens
 * that Hermes thread; a session link missing either id is invalid. Other URLs (including
 * other Apollo links such as pairing) return undefined and go to the system.
 */
export function parseApolloLink(url: string): ApolloLink | undefined {
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return undefined; }
  if (!APOLLO_SCHEMES.has(parsed.protocol.toLowerCase()) || parsed.hostname.toLowerCase() !== 'session') return undefined;
  const segments = parsed.pathname.split('/').filter(Boolean);
  let id = '';
  try { id = segments.length === 1 ? decodeURIComponent(segments[0]) : ''; } catch { /* malformed escape */ }
  const agentId = parsed.searchParams.get('agentId') ?? '';
  return ID.test(id) && ID.test(agentId) ? { kind: 'session', id, agentId } : { kind: 'invalid' };
}

export function isOpenableUrl(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(url.trim())?.[1]?.toLowerCase();
  return scheme !== undefined && OPENABLE_SCHEMES.has(scheme);
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
