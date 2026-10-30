import type { Action } from 'expo-quick-actions';

export type RecentThread = { agentId: string; sessionId: string; title: string };

export type ShortcutDestination =
  | { pathname: '/' }
  | { pathname: '/session/[id]'; params: { id: string; agentId: string } };

// iOS shows 4 quick actions: "New thread" plus up to 3 recently opened threads.
export const MAX_RECENT_THREADS = 3;
export const NEW_THREAD_SHORTCUT_ID = 'new-thread';
export const RECENT_THREADS_STORAGE_KEY = 'apollo.shortcut-recent-threads.v1';

const ID = /^[A-Za-z0-9._~-]{1,256}$/u;
const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value) && value !== 'new';

/**
 * Records an opened thread as the most recent. Returns the same array when nothing changed so
 * effects keyed on it skip storage and launcher writes. An empty title never replaces a known one,
 * since a thread is often recorded before its session list (and title) loads.
 */
export function withRecentThread(current: readonly RecentThread[], opened: RecentThread): readonly RecentThread[] {
  const existing = current.find((thread) => thread.agentId === opened.agentId && thread.sessionId === opened.sessionId);
  const title = opened.title.trim() || existing?.title || '';
  if (existing && current[0] === existing && existing.title === title) return current;
  return [{ agentId: opened.agentId, sessionId: opened.sessionId, title }, ...current.filter((thread) => thread !== existing)]
    .slice(0, MAX_RECENT_THREADS);
}

/** The thread a route shows, or undefined for other routes, drafts, and malformed params. */
export function activeThread(pathname: string, params: { id?: unknown; agentId?: unknown }): { agentId: string; sessionId: string } | undefined {
  const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
  const sessionId = first(params.id);
  const agentId = first(params.agentId);
  if (pathname.startsWith('/session/') && isId(agentId) && isId(sessionId)) return { agentId, sessionId };
}

/** Persisted recents, dropping anything malformed instead of failing the whole list. */
export function parseRecentThreads(stored: string | null): RecentThread[] {
  let value: unknown;
  try { value = stored ? JSON.parse(stored) : []; } catch { return []; }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const { agentId, sessionId, title } = item as Record<string, unknown>;
    return isId(agentId) && isId(sessionId) ? [{ agentId, sessionId, title: typeof title === 'string' ? title : '' }] : [];
  }).slice(0, MAX_RECENT_THREADS);
}

/** Launcher items: the static "New thread" first, then recents. `icon` maps a logical icon to the platform's. */
export function buildShortcutActions(recents: readonly RecentThread[], icon: (kind: 'new' | 'thread') => string): Action[] {
  return [
    { id: NEW_THREAD_SHORTCUT_ID, title: 'New thread', icon: icon('new'), params: { kind: 'new' } },
    ...recents.slice(0, MAX_RECENT_THREADS).map((thread): Action => ({
      // JSON keeps the agent/session pair unambiguous, so two threads never share a launcher id.
      id: `thread:${JSON.stringify([thread.agentId, thread.sessionId])}`,
      title: thread.title.trim() || 'Thread',
      icon: icon('thread'),
      params: { kind: 'thread', agentId: thread.agentId, sessionId: thread.sessionId },
    })),
  ];
}

/**
 * Where a tapped shortcut goes, or undefined to ignore it. Launchers keep shortcuts across app
 * updates and unpairing, so params are checked against the exact shapes built above and the
 * currently paired agents. "New thread" uses the agent of the latest recent thread, else the first.
 */
export function shortcutDestination(action: Action, agentIds: readonly string[], recents: readonly RecentThread[]): ShortcutDestination | undefined {
  const params = action.params;
  if (params?.kind === 'new') {
    const agentId = [recents[0]?.agentId, agentIds[0]].find((id) => id !== undefined && agentIds.includes(id));
    return agentId ? { pathname: '/session/[id]', params: { id: 'new', agentId } } : { pathname: '/' };
  }
  if (params?.kind === 'thread' && isId(params.agentId) && isId(params.sessionId) && agentIds.includes(params.agentId)) {
    return { pathname: '/session/[id]', params: { id: params.sessionId, agentId: params.agentId } };
  }
}
