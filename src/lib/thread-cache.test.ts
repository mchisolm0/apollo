import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CACHED_THREADS_PER_AGENT, createThreadCache, mergeLiveHistory, persistableMessages, THREAD_CACHE_LAYOUT_VERSION, type CacheDatabase } from './thread-cache.ts';
import type { HermesMessage } from './types.ts';

const adapter = (sqlite: DatabaseSync, delayInserts = false): CacheDatabase => ({
  execAsync: async (source) => { sqlite.exec(source); },
  runAsync: async (source, params) => {
    // expo-sqlite can finish a later call first; a slow insert shows whether calls still land in order.
    if (delayInserts && source.startsWith('INSERT')) await new Promise((resolve) => setTimeout(resolve, 5));
    return sqlite.prepare(source).run(...params);
  },
  getAllAsync: async <Row>(source: string, params: (string | number | null)[]) => sqlite.prepare(source).all(...params) as Row[],
  closeAsync: async () => { sqlite.close(); },
});

function memoryCache(options: { delayInserts?: boolean } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  let clock = 0;
  const cache = createThreadCache({ open: async () => adapter(sqlite, options.delayInserts), remove: async () => undefined }, () => ++clock);
  return { sqlite, cache };
}

const count = (sqlite: DatabaseSync, table: string) => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
const saved = (sequence: number, role = 'assistant'): HermesMessage => ({ id: `m${sequence}`, sequence, role, content: role });

test('only server-saved messages are cached, never optimistic sends', async () => {
  const { cache } = memoryCache();
  const pending: HermesMessage = { id: 'run-user-r1', role: 'user', content: 'Next' };
  assert.deepEqual(persistableMessages([saved(1), pending]), [saved(1)]);
  await cache.saveThread('a', 's', [saved(1), pending]);
  assert.deepEqual(await cache.loadThread('a', 's'), [saved(1)]);
  await cache.saveThread('a', 'only-pending', [pending]);
  assert.equal(await cache.loadThread('a', 'only-pending'), undefined);
});

test('each agent keeps its most recently used threads', async () => {
  const { sqlite, cache } = memoryCache();
  for (let index = 0; index <= CACHED_THREADS_PER_AGENT; index++) await cache.saveThread('a', `s${index}`, [saved(index)]);
  await cache.saveThread('b', 'other', [saved(1)]);
  // s0 is the oldest and goes first, unless reading it counted as a use.
  assert.equal(await cache.loadThread('a', 's0'), undefined);
  assert.ok(await cache.loadThread('a', 's1'));
  await cache.saveThread('a', 'newest', [saved(1)]);
  assert.ok(await cache.loadThread('a', 's1'));
  assert.equal(await cache.loadThread('a', 's2'), undefined);
  assert.ok(await cache.loadThread('b', 'other'));
  // Eviction reads only the index, never the message blobs.
  const plan = sqlite.prepare('EXPLAIN QUERY PLAN SELECT session_id FROM threads WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?').all('a', 1);
  assert.match(String(plan.at(-1)?.detail), /COVERING INDEX threads_recency/);
});

test('saving the same history again is skipped until the row is gone', async () => {
  const { sqlite, cache } = memoryCache();
  const writes = () => Number(sqlite.prepare("SELECT updated_at FROM threads WHERE session_id = 's'").get()?.updated_at);
  await cache.saveThread('a', 's', [saved(1), saved(2)]);
  const first = writes();
  await cache.saveThread('a', 's', [saved(1), saved(2)]);
  assert.equal(writes(), first);
  await cache.saveThread('a', 's', [saved(1), saved(2), saved(3)]);
  assert.ok(writes() > first);
  await cache.removeThread('a', 's');
  await cache.saveThread('a', 's', [saved(1), saved(2), saved(3)]);
  assert.ok(await cache.loadThread('a', 's'));
  for (let index = 0; index < CACHED_THREADS_PER_AGENT; index++) await cache.saveThread('a', `other${index}`, [saved(index)]);
  assert.equal(count(sqlite, "threads WHERE session_id = 's'"), 0);
  await cache.saveThread('a', 's', [saved(1), saved(2), saved(3)]);
  assert.ok(await cache.loadThread('a', 's'));
});

test('a delete issued after a save lands after it', async () => {
  const { sqlite, cache } = memoryCache({ delayInserts: true });
  const operations = [cache.saveThread('a', 's', [saved(1)]), cache.removeThread('a', 's'), cache.saveThread('b', 's', [saved(1)]), cache.clearAgent('b')];
  await Promise.all(operations);
  assert.equal(count(sqlite, 'threads'), 0);
});

test('corrupt rows are dropped without throwing', async () => {
  const { sqlite, cache } = memoryCache();
  await cache.saveThread('a', 'good', [saved(1)]);
  await cache.saveList('a', [{ id: 'good' }]);
  const insertThread = sqlite.prepare('INSERT INTO threads (agent_id, session_id, updated_at, json) VALUES (?, ?, ?, ?)');
  insertThread.run('a', 'broken', 1, '{not json');
  insertThread.run('a', 'wrong-shape', 1, '[{"role":"user"}]');
  sqlite.prepare('INSERT INTO thread_lists (agent_id, json) VALUES (?, ?)').run('b', '{"id":"x"}');
  assert.equal(await cache.loadThread('a', 'broken'), undefined);
  assert.equal(await cache.loadThread('a', 'wrong-shape'), undefined);
  assert.deepEqual([...(await cache.loadLists()).entries()], [['a', [{ id: 'good' }]]]);
  assert.equal(count(sqlite, 'threads'), 1);
  assert.equal(count(sqlite, 'thread_lists'), 1);
});

test('a database in an older layout is dropped and recreated', async () => {
  const sqlite = new DatabaseSync(':memory:');
  // The first release's layout, which had no user_version.
  sqlite.exec(`CREATE TABLE threads (agent_id TEXT NOT NULL, session_id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL,
    schema_version INTEGER NOT NULL, PRIMARY KEY (agent_id, session_id));
    CREATE TABLE thread_lists (agent_id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL, schema_version INTEGER NOT NULL);
    INSERT INTO threads VALUES ('a', 's', '[]', 1, 1);`);
  const cache = createThreadCache({ open: async () => adapter(sqlite), remove: async () => undefined });
  assert.equal(await cache.loadThread('a', 's'), undefined);
  await cache.saveThread('a', 's', [saved(1)]);
  assert.deepEqual(sqlite.prepare('PRAGMA table_info(threads)').all().map((column) => column.name), ['agent_id', 'session_id', 'updated_at', 'json']);
  assert.equal(sqlite.prepare('PRAGMA user_version').get()?.user_version, THREAD_CACHE_LAYOUT_VERSION);
  // A current layout is left alone.
  const reopened = createThreadCache({ open: async () => adapter(sqlite), remove: async () => undefined });
  assert.deepEqual(await reopened.loadThread('a', 's'), [saved(1)]);
});

test('an unreadable database file is deleted and opened again', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'thread-cache-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'cache.db');
  writeFileSync(path, 'not a database, just bytes');
  const cache = createThreadCache({ open: async () => adapter(new DatabaseSync(path)), remove: async () => rmSync(path, { force: true }) });
  await cache.saveThread('a', 's', [saved(1)]);
  assert.deepEqual(await cache.loadThread('a', 's'), [saved(1)]);
});

test('a failed open is tried again on the next call', async () => {
  const sqlite = new DatabaseSync(':memory:');
  let opens = 0;
  const cache = createThreadCache({
    open: async () => {
      if (++opens <= 2) throw new Error('unavailable');
      return adapter(sqlite);
    },
    remove: async () => undefined,
  });
  await assert.rejects(cache.loadThread('a', 's'), /unavailable/);
  await cache.saveThread('a', 's', [saved(1)]);
  assert.deepEqual(await cache.loadThread('a', 's'), [saved(1)]);
});

test('removing an agent clears its cache, and unpaired agents are dropped', async () => {
  const { cache } = memoryCache();
  await cache.saveThread('a', 's', [saved(1)]);
  await cache.saveList('a', [{ id: 's' }]);
  await cache.saveThread('b', 's', [saved(1)]);
  await cache.saveList('b', [{ id: 's' }]);
  await cache.saveThread('c', 's', [saved(1)]);
  await cache.clearAgent('a');
  await cache.retainAgents(['b']);
  assert.equal(await cache.loadThread('a', 's'), undefined);
  assert.equal(await cache.loadThread('c', 's'), undefined);
  assert.ok(await cache.loadThread('b', 's'));
  assert.deepEqual([...(await cache.loadLists()).keys()], ['b']);
  // Cleared threads are written again, not skipped as unchanged.
  await cache.saveThread('a', 's', [saved(1)]);
  assert.ok(await cache.loadThread('a', 's'));
});

async function cachedThread(messages: readonly HermesMessage[]) {
  const { cache } = memoryCache();
  await cache.saveThread('a', 's', messages);
  const cached = await cache.loadThread('a', 's');
  assert.ok(cached);
  return cached;
}

test('live history replaces a cached copy, even a shorter one', async () => {
  const cached = await cachedThread([saved(1, 'user'), saved(2), saved(3, 'user'), saved(4)]);
  const shortened = [saved(1, 'user'), saved(2)];
  assert.equal(mergeLiveHistory(cached, shortened), shortened);
  const growing = [saved(1, 'user'), saved(2), saved(3, 'user'), saved(4), saved(5, 'user'), saved(6)];
  assert.equal(mergeLiveHistory(cached, growing), growing);
});

test('a send made on top of cached history survives the live load', async () => {
  const cached = await cachedThread([saved(1, 'user'), saved(2)]);
  const withSend = [...cached, { id: 'run-user-r1', role: 'user', content: 'Offline' }];
  const merged = mergeLiveHistory(withSend, [saved(1, 'user'), saved(2)]);
  assert.equal(merged.at(-1)?.id, 'run-user-r1');
});

test('once live history lands, a stale page cannot roll it back', async () => {
  const cached = await cachedThread([saved(1, 'user'), saved(2)]);
  const live = mergeLiveHistory(cached, [saved(1, 'user'), saved(2), saved(3, 'user'), saved(4)]);
  assert.equal(mergeLiveHistory(live, [saved(1, 'user'), saved(2)]), live);
});
