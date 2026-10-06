import assert from 'node:assert/strict';
import test from 'node:test';

import { getSessionDraftStore, SessionDraftStore, type DraftStorage } from './session-draft.ts';

const file = { id: 'a', name: 'a.txt', mimeType: 'text/plain', size: 2, uri: 'file:///a.txt' };
function memory(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    values,
    async getItem(key: string) { return values[key] ?? null; },
    async setItem(key: string, value: string) { values[key] = value; },
    async removeItem(key: string) { delete values[key]; },
  };
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a failed source cleanup keeps a moved draft retryable', async () => {
  const storage = memory();
  const store = new SessionDraftStore('cleanup', 'new', { storage, uuid: () => 'delivery' });
  await store.load();
  store.setDraft('keep me');
  await wait();
  const prepared = await store.prepareSend();
  const remove = storage.removeItem;
  storage.removeItem = async () => { throw new Error('cleanup failed'); };
  await assert.rejects(store.move('thread', '', []), /cleanup failed/);
  assert.equal(store.getSnapshot().draft, 'keep me');
  assert.deepEqual(await store.prepareSend(), prepared);
  storage.removeItem = remove;
  await store.move('thread', '', []);
  assert.equal(storage.values[store.key], undefined);
  assert.equal(store.getSnapshot().draft, '');
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('deduplicates share receipts and keeps prepared identity after relaunch', async () => {
  const storage = memory(); const options = { storage, uuid: (() => { let i = 0; return () => `uuid-${++i}`; })() };
  const first = new SessionDraftStore('a', 'new', options); await first.load();
  await first.appendShare('share-1', 'hello', [file]); await first.appendShare('share-1', 'again', [file]);
  const prepared = await first.prepareSend();
  const second = new SessionDraftStore('a', 'new', options); await second.load();
  assert.deepEqual(await second.prepareSend(), prepared);
});

test('editing resets identity, failures keep edits, and old keys migrate', async () => {
  const storage = memory({ 'apollo.draft.a.new': 'old', 'apollo.draft.a.new:attachments': JSON.stringify([file]) });
  let uuid = 0;
  const options = { storage, uuid: () => `next-${++uuid}` };
  const migrated = new SessionDraftStore('a', 'new', options); await migrated.load(); assert.equal(migrated.getSnapshot().draft, 'old');
  const initial = await migrated.prepareSend(); migrated.setDraft('edited'); assert.notEqual((await migrated.prepareSend()).id, initial.id);
  const failing: DraftStorage = { getItem: async () => null, setItem: async () => { throw new Error('disk full'); }, removeItem: async () => undefined };
  const store = new SessionDraftStore('b', 'new', { storage: failing, uuid: () => 'id' }); await store.load(); store.setDraft('kept'); await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(store.getSnapshot().draft, 'kept'); assert.ok(store.getSnapshot().error);
});

test('concurrent load does not replace an edit made while storage is pending', async () => {
  const values: Record<string, string> = { 'apollo.draft.v2.a.new': JSON.stringify({ version: 2, draft: 'saved', attachments: [], receipts: [] }) };
  const storage: DraftStorage = { getItem: async (key) => { await wait(); return values[key] ?? null; }, setItem: async (key, value) => { values[key] = value; }, removeItem: async (key) => { delete values[key]; } };
  const store = new SessionDraftStore('a', 'new', { storage, uuid: () => 'id' });
  const first = store.load(); const second = store.load(); store.setDraft('edited'); await Promise.all([first, second]); await wait();
  assert.equal(store.getSnapshot().draft, 'edited');
});

test('concurrent share imports retain both receipts and both payloads', async () => {
  const storage = memory();
  const store = new SessionDraftStore('concurrent', 'new', { storage, uuid: () => 'id' });
  await store.load();
  await Promise.all([store.appendShare('one', 'first', []), store.appendShare('two', 'second', [])]);
  assert.equal(store.getSnapshot().draft, 'first\n\nsecond');
  assert.match(storage.values['apollo.draft.v2.concurrent.new'], /"one"/);
  assert.match(storage.values['apollo.draft.v2.concurrent.new'], /"two"/);
});

test('moving updates an already loaded destination store', async () => {
  const storage = memory();
  const source = getSessionDraftStore('move', 'new', { storage, uuid: () => 'id' });
  const destination = getSessionDraftStore('move', 'session', { storage, uuid: () => 'id' });
  await Promise.all([source.load(), destination.load()]);
  source.setDraft('carried'); await wait(); await source.move('session', 'carried', []);
  assert.equal(destination.getSnapshot().draft, 'carried');
});

test('unreadable records stay untouched and block preparation', async () => {
  const storage = memory({ 'apollo.draft.v2.bad.new': '{broken' });
  const store = new SessionDraftStore('bad', 'new', { storage, uuid: () => 'id' });
  await store.load(); store.setDraft('keep in memory'); await wait();
  assert.equal(storage.values['apollo.draft.v2.bad.new'], '{broken');
  await assert.rejects(store.prepareSend());
});

test('failed saves block prepareSend until a later edit can retry', async () => {
  let fail = true;
  const storage: DraftStorage = { getItem: async () => null, setItem: async () => { if (fail) throw new Error('disk full'); }, removeItem: async () => undefined };
  const store = new SessionDraftStore('retry', 'new', { storage, uuid: () => 'id' }); await store.load(); store.setDraft('retry me'); await wait();
  await assert.rejects(store.prepareSend());
  fail = false; store.setDraft('retry me'); const prepared = await store.prepareSend(); assert.equal(prepared.text, 'retry me');
});

test('a delayed restore merges disk receipts without replacing an overlapping edit', async () => {
  const read = deferred<string | null>();
  const values: Record<string, string> = {};
  const storage: DraftStorage = {
    getItem: (key) => key.includes('.v2.') ? read.promise : Promise.resolve(null),
    async setItem(key, value) { values[key] = value; },
    async removeItem(key) { delete values[key]; },
  };
  const store = new SessionDraftStore('load-race', 'new', { storage, uuid: () => 'id' });
  const loading = store.load();
  store.setDraft('typed while loading');
  read.resolve(JSON.stringify({ version: 2, draft: 'old disk text', attachments: [], receipts: ['kept-receipt'] }));
  await loading; await wait();
  assert.equal(store.getSnapshot().draft, 'typed while loading');
  assert.deepEqual(JSON.parse(values['apollo.draft.v2.load-race.new']).receipts, ['kept-receipt']);
  assert.equal(JSON.parse(values['apollo.draft.v2.load-race.new']).draft, 'typed while loading');
});

test('an edit during share persistence wins without losing the share receipt', async () => {
  const storage = memory();
  const store = new SessionDraftStore('share-race', 'new', { storage, uuid: () => 'id' });
  await store.load();
  const blocked = deferred<void>();
  const started = deferred<void>();
  let writes = 0;
  storage.setItem = async (key, value) => {
    writes += 1;
    if (writes === 1) { started.resolve(); await blocked.promise; }
    storage.values[key] = value;
  };
  const appending = store.appendShare('receipt', 'shared', []);
  await started.promise;
  store.setDraft('shared\n\ntyped');
  blocked.resolve();
  await appending; await wait();
  const saved = JSON.parse(storage.values['apollo.draft.v2.share-race.new']);
  assert.equal(saved.draft, 'shared\n\ntyped');
  assert.deepEqual(saved.receipts, ['receipt']);
});

test('an edit during prepare rejects the stale send and persists the edit', async () => {
  const storage = memory();
  const store = new SessionDraftStore('prepare-race', 'new', { storage, uuid: () => 'prepared' });
  await store.load(); store.setDraft('before'); await wait();
  const blocked = deferred<void>();
  const started = deferred<void>();
  storage.setItem = async (key, value) => { started.resolve(); await blocked.promise; storage.values[key] = value; };
  const preparing = store.prepareSend();
  await started.promise;
  store.setDraft('after');
  blocked.resolve();
  await assert.rejects(preparing, /changed while preparing/);
  await wait();
  const saved = JSON.parse(storage.values['apollo.draft.v2.prepare-race.new']);
  assert.equal(saved.draft, 'after');
  assert.equal(saved.prepared, undefined);
});

test('failed clear and move operations leave the prepared draft retryable', async () => {
  const clearStorage = memory();
  const clearStore = new SessionDraftStore('clear-retry', 'thread', { storage: clearStorage, uuid: () => 'clear-id' });
  await clearStore.load(); clearStore.setDraft('keep me'); await wait();
  const clearPrepared = await clearStore.prepareSend();
  const clearSetItem = clearStorage.setItem;
  let failClear = true;
  clearStorage.setItem = async (key, value) => {
    if (failClear) throw new Error('disk full');
    await clearSetItem(key, value);
  };
  await assert.rejects(clearStore.clear(), /Try clearing the draft again/);
  assert.equal(clearStore.getSnapshot().draft, 'keep me');
  assert.deepEqual(await clearStore.prepareSend(), clearPrepared);
  failClear = false;
  await clearStore.clear();
  assert.equal(clearStore.getSnapshot().draft, '');

  const moveStorage = memory();
  const moveStore = new SessionDraftStore('move-retry', 'new', { storage: moveStorage, uuid: () => 'move-id' });
  await moveStore.load(); moveStore.setDraft('move me'); await wait();
  const movePrepared = await moveStore.prepareSend();
  const moveSetItem = moveStorage.setItem;
  let failMove = true;
  moveStorage.setItem = async (key, value) => {
    if (failMove && key === 'apollo.draft.v2.move-retry.thread') throw new Error('disk full');
    await moveSetItem(key, value);
  };
  await assert.rejects(moveStore.move('thread', '', []), /Try opening the thread again/);
  assert.equal(moveStore.getSnapshot().draft, 'move me');
  assert.deepEqual(await moveStore.prepareSend(), movePrepared);
  failMove = false;
  await moveStore.move('thread', '', []);
  assert.equal(moveStore.getSnapshot().draft, '');
});

test('share receipt history stays within the persisted record limit', async () => {
  const storage = memory({ 'apollo.draft.v2.receipts.new': JSON.stringify({ version: 2, draft: '', attachments: [], receipts: Array.from({ length: 1000 }, (_, index) => `old-${index}`) }) });
  const store = new SessionDraftStore('receipts', 'new', { storage, uuid: () => 'id' });
  await store.load(); await store.appendShare('latest', 'shared', []);
  const saved = JSON.parse(storage.values['apollo.draft.v2.receipts.new']);
  assert.equal(saved.receipts.length, 1000);
  assert.equal(saved.receipts.at(-1), 'latest');
});

test('a new composer after promotion cannot overwrite the previous thread draft', async () => {
  const storage = memory();
  let count = 0;
  const options = { storage, uuid: () => `id-${++count}` };
  const original = getSessionDraftStore('promotion', 'new', options);
  await original.load(); original.setDraft('first'); await wait();
  await original.move('thread-one', '', []);
  const next = getSessionDraftStore('promotion', 'new', options);
  assert.notEqual(next, original);
  await next.load(); next.setDraft('second'); await wait();
  assert.equal(JSON.parse(storage.values['apollo.draft.v2.promotion.thread-one']).draft, '');
  assert.equal(JSON.parse(storage.values['apollo.draft.v2.promotion.new']).draft, 'second');
});
