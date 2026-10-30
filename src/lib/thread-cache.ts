import type { HermesMessage, HermesSession } from './types.ts';

/** Bump when the stored JSON shape changes; rows from other versions are dropped. */
export const THREAD_CACHE_SCHEMA_VERSION = 1;
/** Threads with cached messages kept per agent, by most recent use. */
export const CACHED_THREADS_PER_AGENT = 30;

type BindValue = string | number | null;

/** The slice of expo-sqlite's SQLiteDatabase the cache uses, so tests can run it on node:sqlite. */
export interface CacheDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: BindValue[]): Promise<unknown>;
  getAllAsync<Row>(source: string, params: BindValue[]): Promise<Row[]>;
}

export interface ThreadCache {
  /** Each agent's last live thread list. */
  loadLists(): Promise<ReadonlyMap<string, readonly HermesSession[]>>;
  saveList(agentId: string, sessions: readonly HermesSession[]): Promise<void>;
  /** A thread's saved messages, or undefined when none are cached. Counts as a use. */
  loadThread(agentId: string, sessionId: string): Promise<readonly HermesMessage[] | undefined>;
  /** Saves only server-saved messages, then keeps the agent's most recently used threads. */
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  PRIMARY KEY (agent_id, session_id)
);
CREATE TABLE IF NOT EXISTS thread_lists (
  agent_id TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL
);
DELETE FROM threads WHERE schema_version <> ${THREAD_CACHE_SCHEMA_VERSION};
DELETE FROM thread_lists WHERE schema_version <> ${THREAD_CACHE_SCHEMA_VERSION};
`;

export function createThreadCache(open: () => Promise<CacheDatabase>, now: () => number = Date.now): ThreadCache {
  let ready: Promise<CacheDatabase> | undefined;
  const database = () => ready ??= open().then(async (db) => {
    await db.execAsync(SCHEMA);
    return db;
  });

  return {
    async loadLists() {
      const db = await database();
      const rows = await db.getAllAsync<{ agent_id: string; json: string }>('SELECT agent_id, json FROM thread_lists', []);
      const lists = new Map<string, readonly HermesSession[]>();
      for (const row of rows) {
        const sessions = decodeSessions(row.json);
        if (sessions) lists.set(row.agent_id, sessions);
        else await db.runAsync('DELETE FROM thread_lists WHERE agent_id = ?', [row.agent_id]);
      }
      return lists;
    },
    async saveList(agentId, sessions) {
      const db = await database();
      await db.runAsync('INSERT OR REPLACE INTO thread_lists (agent_id, json, updated_at, schema_version) VALUES (?, ?, ?, ?)',
        [agentId, JSON.stringify(sessions), now(), THREAD_CACHE_SCHEMA_VERSION]);
    },
    async loadThread(agentId, sessionId) {
      const db = await database();
      const [row] = await db.getAllAsync<{ json: string }>('SELECT json FROM threads WHERE agent_id = ? AND session_id = ?', [agentId, sessionId]);
      if (!row) return undefined;
      const messages = decodeMessages(row.json);
      if (messages) await db.runAsync('UPDATE threads SET updated_at = ? WHERE agent_id = ? AND session_id = ?', [now(), agentId, sessionId]);
      else await db.runAsync('DELETE FROM threads WHERE agent_id = ? AND session_id = ?', [agentId, sessionId]);
      return messages;
    },
    async saveThread(agentId, sessionId, messages) {
      const saved = persistableMessages(messages);
      if (!saved.length) return;
      const db = await database();
      await db.runAsync('INSERT OR REPLACE INTO threads (agent_id, session_id, json, updated_at, schema_version) VALUES (?, ?, ?, ?, ?)',
        [agentId, sessionId, JSON.stringify(saved), now(), THREAD_CACHE_SCHEMA_VERSION]);
      await db.runAsync(`DELETE FROM threads WHERE agent_id = ? AND session_id NOT IN (
        SELECT session_id FROM threads WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?)`,
      [agentId, agentId, CACHED_THREADS_PER_AGENT]);
    },
    async removeThread(agentId, sessionId) {
      const db = await database();
      await db.runAsync('DELETE FROM threads WHERE agent_id = ? AND session_id = ?', [agentId, sessionId]);
    },
    async clearAgent(agentId) {
      const db = await database();
      await db.runAsync('DELETE FROM threads WHERE agent_id = ?', [agentId]);
      await db.runAsync('DELETE FROM thread_lists WHERE agent_id = ?', [agentId]);
    },
    async retainAgents(agentIds) {
      const db = await database();
      const placeholders = agentIds.map(() => '?').join(', ');
      await db.runAsync(`DELETE FROM threads WHERE agent_id NOT IN (${placeholders})`, [...agentIds]);
      await db.runAsync(`DELETE FROM thread_lists WHERE agent_id NOT IN (${placeholders})`, [...agentIds]);
    },
  };
}
