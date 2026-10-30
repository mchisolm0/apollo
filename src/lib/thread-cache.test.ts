import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { reconcileHistory } from './message-history.ts';
import { CACHED_THREADS_PER_AGENT, createThreadCache, persistableMessages, THREAD_CACHE_SCHEMA_VERSION, type CacheDatabase } from './thread-cache.ts';
import type { HermesMessage } from './types.ts';

const adapter = (sqlite: DatabaseSync): CacheDatabase => ({
  execAsync: async (source) => { sqlite.exec(source); },
  runAsync: async (source, params) => sqlite.prepare(source).run(...params),
  getAllAsync: async <Row>(source: string, params: (string | number | null)[]) => sqlite.prepare(source).all(...params) as Row[],
});

function memoryCache() {
  const sqlite = new DatabaseSync(':memory:');
  let clock = 0;
  return { sqlite, cache: createThreadCache(async () => adapter(sqlite), () => ++clock) };
}

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
  const { cache } = memoryCache();
  for (let index = 0; index <= CACHED_THREADS_PER_AGENT; index++) await cache.saveThread('a', `s${index}`, [saved(index)]);
  await cache.saveThread('b', 'other', [saved(1)]);
  // s0 is the oldest and goes first, unless reading it counted as a use.
  assert.equal(await cache.loadThread('a', 's0'), undefined);
  assert.ok(await cache.loadThread('a', 's1'));
  await cache.saveThread('a', 'newest', [saved(1)]);
  assert.ok(await cache.loadThread('a', 's1'));
  assert.equal(await cache.loadThread('a', 's2'), undefined);
  assert.ok(await cache.loadThread('b', 'other'));
});

test('corrupt and old-schema rows are dropped without throwing', async () => {
  const { sqlite, cache } = memoryCache();
  await cache.saveThread('a', 'good', [saved(1)]);
  await cache.saveList('a', [{ id: 'good' }]);
  sqlite.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run('a', 'broken', '{not json', 1, THREAD_CACHE_SCHEMA_VERSION);
  sqlite.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run('a', 'wrong-shape', '[{"role":"user"}]', 1, THREAD_CACHE_SCHEMA_VERSION);
  sqlite.prepare('INSERT INTO thread_lists VALUES (?, ?, ?, ?)').run('b', '{"id":"x"}', 1, THREAD_CACHE_SCHEMA_VERSION);
  assert.equal(await cache.loadThread('a', 'broken'), undefined);
  assert.equal(await cache.loadThread('a', 'wrong-shape'), undefined);
  assert.deepEqual([...(await cache.loadLists()).entries()], [['a', [{ id: 'good' }]]]);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM threads').get()?.n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM thread_lists').get()?.n, 1);

  // A row from an older format is gone the next time the cache opens.
  sqlite.prepare('UPDATE threads SET schema_version = ?').run(THREAD_CACHE_SCHEMA_VERSION - 1);
  const reopened = createThreadCache(async () => adapter(sqlite));
  assert.equal(await reopened.loadThread('a', 'good'), undefined);
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
});

test('live history replaces the cached copy without duplicates', async () => {
  const { cache } = memoryCache();
  await cache.saveThread('a', 's', [saved(1, 'user'), saved(2)]);
  const cached = await cache.loadThread('a', 's') ?? [];
  const live = [saved(1, 'user'), saved(2), saved(3, 'user'), saved(4)];
  assert.deepEqual(reconcileHistory(cached, live), live);
  // A stale live page cannot roll the cached thread back.
  assert.deepEqual(reconcileHistory(live, cached), live);
});
