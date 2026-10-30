import { reconcileHistory } from './message-history.ts';
import type { HermesMessage, HermesSession } from './types.ts';

/** Bump when the tables or the stored JSON shape change; any other version is dropped and recreated. */
export const THREAD_CACHE_LAYOUT_VERSION = 2;
/** Threads with cached messages kept per agent, by most recent use. */
export const CACHED_THREADS_PER_AGENT = 30;

type BindValue = string | number | null;

/** The slice of expo-sqlite's SQLiteDatabase the cache uses, so tests can run it on node:sqlite. */
export interface CacheDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: BindValue[]): Promise<unknown>;
  getAllAsync<Row>(source: string, params: BindValue[]): Promise<Row[]>;
  closeAsync(): Promise<void>;
}

export interface CacheStorage {
  open(): Promise<CacheDatabase>;
  /** Deletes the database file, once it is closed, so an unreadable cache starts over. */
  remove(): Promise<void>;
}

export interface ThreadCache {
  /** Each agent's last live thread list. */
  loadLists(): Promise<ReadonlyMap<string, readonly HermesSession[]>>;
  saveList(agentId: string, sessions: readonly HermesSession[]): Promise<void>;
  /** A thread's saved messages, or undefined when none are cached. Counts as a use. */
  loadThread(agentId: string, sessionId: string): Promise<readonly HermesMessage[] | undefined>;
  /** Saves only server-saved messages, then keeps the agent's most recently used threads. An empty history removes the thread. */
  saveThread(agentId: string, sessionId: string, messages: readonly HermesMessage[]): Promise<void>;
  removeThread(agentId: string, sessionId: string): Promise<void>;
  clearAgent(agentId: string): Promise<void>;
  /** Drops agents no longer paired, such as a save that landed after removal. */
  retainAgents(agentIds: readonly string[]): Promise<void>;
}

/** Optimistic `run-user-*` rows have no server sequence; the outbox owns those. */
export function persistableMessages(messages: readonly HermesMessage[]) {
  return messages.filter((message) => typeof message.sequence === 'number');
}

// Arrays loadThread returned. Nothing live has touched them yet.
const fromCache = new WeakSet<readonly HermesMessage[]>();

/**
 * Merges a live history page into a thread. A copy straight from the cache gives way to it
 * entirely, so turns the server no longer has go too. Anything else reconciles, which keeps
 * offline sends and stops a stale page from rolling the thread back.
 */
export function mergeLiveHistory(existing: readonly HermesMessage[] | undefined, loaded: readonly HermesMessage[]) {
  return existing && fromCache.has(existing) ? loaded : reconcileHistory(existing ?? [], loaded);
}

function parseArray(json: string): unknown[] | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isMessage = (value: unknown): value is HermesMessage => isRecord(value) && typeof value.role === 'string'
  && typeof value.sequence === 'number' && (value.content === undefined || typeof value.content === 'string');

const isSession = (value: unknown): value is HermesSession => isRecord(value) && typeof value.id === 'string'
  && (value.title === undefined || typeof value.title === 'string');

export function decodeMessages(json: string): readonly HermesMessage[] | undefined {
  const value = parseArray(json);
  return value?.every(isMessage) ? value : undefined;
}

export function decodeSessions(json: string): readonly HermesSession[] | undefined {
  const value = parseArray(json);
  return value?.every(isSession) ? value : undefined;
}

// `json` goes last and the recency index covers eviction, so neither reads the message blobs.
const LAYOUT = `
BEGIN;
DROP TABLE IF EXISTS threads;
DROP TABLE IF EXISTS thread_lists;
CREATE TABLE threads (
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (agent_id, session_id)
);
CREATE INDEX threads_recency ON threads (agent_id, updated_at, session_id);
CREATE TABLE thread_lists (
  agent_id TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL
);
PRAGMA user_version = ${THREAD_CACHE_LAYOUT_VERSION};
COMMIT;
`;

// SQLite's messages for SQLITE_NOTADB and SQLITE_CORRUPT, including a malformed schema.
const CORRUPT = /file is not a database|malformed/u;

async function prepare(db: CacheDatabase) {
  const [row] = await db.getAllAsync<{ user_version: number }>('PRAGMA user_version', []);
  if (row?.user_version !== THREAD_CACHE_LAYOUT_VERSION) await db.execAsync(LAYOUT);
  return db;
}

export function createThreadCache(storage: CacheStorage, now: () => number = Date.now): ThreadCache {
  let ready: Promise<CacheDatabase> | undefined;
  // A corrupt file starts over empty, once. Any failed open is tried again on the next call.
  const attempt = async (retry: boolean): Promise<CacheDatabase> => {
    let db: CacheDatabase | undefined;
    try {
      db = await storage.open();
      return await prepare(db);
    } catch (error) {
      await db?.closeAsync().catch(() => undefined);
      if (!retry || !CORRUPT.test(error instanceof Error ? error.message : String(error))) throw error;
      await storage.remove();
      return attempt(false);
    }
  };
  const database = () => ready ??= attempt(true).catch((error: unknown) => {
    ready = undefined;
    throw error;
  });

  // expo-sqlite runs async calls concurrently, so a delete could land before an earlier save.
  // Every operation waits for the one before it.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: (db: CacheDatabase) => Promise<T>): Promise<T> => {
    const result = tail.then(database).then(operation);
    tail = result.catch(() => undefined);
    return result;
  };

  // Message count and newest sequence of each thread's last write, by agent, to skip saving the same history again.
  const written = new Map<string, Map<string, string>>();
  const removeThread = (agentId: string, sessionId: string) => serial(async (db) => {
    written.get(agentId)?.delete(sessionId);
    await db.runAsync('DELETE FROM threads WHERE agent_id = ? AND session_id = ?', [agentId, sessionId]);
  });

  return {
    loadLists: () => serial(async (db) => {
      const rows = await db.getAllAsync<{ agent_id: string; json: string }>('SELECT agent_id, json FROM thread_lists', []);
      const lists = new Map<string, readonly HermesSession[]>();
      for (const row of rows) {
        const sessions = decodeSessions(row.json);
        if (sessions) lists.set(row.agent_id, sessions);
        else await db.runAsync('DELETE FROM thread_lists WHERE agent_id = ?', [row.agent_id]);
      }
      return lists;
    }),
    saveList: (agentId, sessions) => serial(async (db) => {
      await db.runAsync('INSERT OR REPLACE INTO thread_lists (agent_id, json) VALUES (?, ?)', [agentId, JSON.stringify(sessions)]);
    }),
    loadThread: (agentId, sessionId) => serial(async (db) => {
      const [row] = await db.getAllAsync<{ json: string }>('SELECT json FROM threads WHERE agent_id = ? AND session_id = ?', [agentId, sessionId]);
      if (!row) return undefined;
      const messages = decodeMessages(row.json);
      if (!messages) {
        written.get(agentId)?.delete(sessionId);
        await db.runAsync('DELETE FROM threads WHERE agent_id = ? AND session_id = ?', [agentId, sessionId]);
        return undefined;
      }
      await db.runAsync('UPDATE threads SET updated_at = ? WHERE agent_id = ? AND session_id = ?', [now(), agentId, sessionId]);
      fromCache.add(messages);
      return messages;
    }),
    saveThread: (agentId, sessionId, messages) => {
      if (!messages.length) return removeThread(agentId, sessionId);
      const saved = persistableMessages(messages);
      if (!saved.length) return Promise.resolve();
      const shape = `${saved.length}:${saved.reduce((newest, message) => Math.max(newest, message.sequence ?? newest), -Infinity)}`;
      return serial(async (db) => {
        if (written.get(agentId)?.get(sessionId) === shape) return;
        await db.runAsync('INSERT OR REPLACE INTO threads (agent_id, session_id, updated_at, json) VALUES (?, ?, ?, ?)',
          [agentId, sessionId, now(), JSON.stringify(saved)]);
        written.set(agentId, (written.get(agentId) ?? new Map<string, string>()).set(sessionId, shape));
        const evicted = await db.getAllAsync<{ session_id: string }>(`DELETE FROM threads WHERE agent_id = ? AND session_id NOT IN (
          SELECT session_id FROM threads WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?) RETURNING session_id`,
        [agentId, agentId, CACHED_THREADS_PER_AGENT]);
        for (const row of evicted) written.get(agentId)?.delete(row.session_id);
      });
    },
    removeThread,
    clearAgent: (agentId) => serial(async (db) => {
      written.delete(agentId);
      await db.runAsync('DELETE FROM threads WHERE agent_id = ?', [agentId]);
      await db.runAsync('DELETE FROM thread_lists WHERE agent_id = ?', [agentId]);
    }),
    retainAgents: (agentIds) => serial(async (db) => {
      for (const agentId of written.keys()) if (!agentIds.includes(agentId)) written.delete(agentId);
      const placeholders = agentIds.map(() => '?').join(', ');
      await db.runAsync(`DELETE FROM threads WHERE agent_id NOT IN (${placeholders})`, [...agentIds]);
      await db.runAsync(`DELETE FROM thread_lists WHERE agent_id NOT IN (${placeholders})`, [...agentIds]);
    }),
  };
}
