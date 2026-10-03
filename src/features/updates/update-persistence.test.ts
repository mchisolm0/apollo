import assert from 'node:assert/strict';
import test from 'node:test';

import { createOutboxRuntime } from '../../lib/outbox.ts';
import { flushSessionDrafts, getSessionDraftStore, SessionDraftStore } from '../../lib/session-draft.ts';

test('draft flush waits for storage and refuses a failed write', async () => {
  let fail = false;
  let saved = '';
  const storage = {
    getItem: async () => null,
    setItem: async (_key: string, value: string) => { if (fail) throw new Error('disk full'); saved = value; },
    removeItem: async () => {},
  };
  const draft = new SessionDraftStore('update-test', 'draft', { storage, uuid: () => 'id' });
  draft.setDraft('Keep this draft');
  assert.equal(await draft.flush(), true);
  assert.equal(JSON.parse(saved).draft, 'Keep this draft');
  fail = true;
  draft.setDraft('Unsaved edit');
  assert.equal(await draft.flush(), false);
  assert.equal(JSON.parse(saved).draft, 'Keep this draft');
});

test('an edit after one draft flushes cancels a reload while another draft is saving', async () => {
  let finishWrite!: () => void;
  let startWrite!: () => void;
  const writing = new Promise<void>((resolve) => { startWrite = resolve; });
  const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
  const storage = {
    getItem: async () => null,
    setItem: async (key: string) => {
      if (key.endsWith('.slow')) { startWrite(); await pendingWrite; }
    },
    removeItem: async () => {},
  };
  const first = getSessionDraftStore('update-flush-test', 'first', { storage, uuid: () => 'first' });
  const second = getSessionDraftStore('update-flush-test', 'slow', { storage, uuid: () => 'second' });
  await Promise.all([first.load(), second.load()]);
  const flushing = flushSessionDrafts();
  await writing;
  await new Promise<void>((resolve) => setImmediate(resolve));
  first.setDraft('Edited while the other draft is saving');
  finishWrite();
  assert.equal(await flushing, false);
  assert.equal(await flushSessionDrafts(), true);
});

test('a preparation queued during the flush cannot report safety before its identity is stored', async () => {
  let finishPreparation!: () => void;
  let startPreparation!: () => void;
  const preparing = new Promise<void>((resolve) => { startPreparation = resolve; });
  const pendingPreparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
  const storage = {
    getItem: async () => null,
    setItem: async (_key: string, value: string) => {
      if (JSON.parse(value).prepared) { startPreparation(); await pendingPreparation; }
    },
    removeItem: async () => {},
  };
  const draft = getSessionDraftStore('update-prepare-test', 'thread', { storage, uuid: () => 'prepared-id' });
  draft.setDraft('Message to prepare');
  await draft.flush();
  let prepare: Promise<unknown> | undefined;
  let armed = true;
  const unsubscribe = draft.subscribe(() => {
    if (!armed) return;
    armed = false;
    queueMicrotask(() => { prepare = draft.prepareSend(); });
  });
  let flushed: boolean | undefined;
  const flushing = flushSessionDrafts().then((result) => { flushed = result; return result; });
  await preparing;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.notEqual(flushed, true);
  finishPreparation();
  await prepare;
  await flushing;
  unsubscribe();
  assert.equal(await flushSessionDrafts(), true);
});

test('outbox safety blocks new sends and skips in-flight delivery', async () => {
  let finishDelivery!: (id: string) => void;
  let startDelivery!: () => void;
  const started = new Promise<void>((resolve) => { startDelivery = resolve; });
  let canSend = false;
  const queue = createOutboxRuntime({
    storage: { getItem: async () => null, setItem: async () => {} },
    canSend: () => canSend,
    deliver: async () => { startDelivery(); return new Promise<string>((resolve) => { finishDelivery = resolve; }); },
    discardAttachments: () => {},
  });
  try {
    const enqueue = queue.enqueue({ id: 'notice-test', agentId: 'agent', sessionId: 'thread', createsSession: false, text: 'Message', attachments: [] });
    assert.equal(await queue.withReloadSafety(async () => { assert.fail('not loaded'); }), false);
    await enqueue;
    canSend = true;
    const sending = queue.drain();
    await started;
    assert.equal(await queue.withReloadSafety(async () => { assert.fail('sending'); }), false);
    finishDelivery('run');
    await sending;
    await queue.enqueue({ id: 'second', agentId: 'agent', sessionId: 'thread', createsSession: false, text: 'Another', attachments: [] });
    const safe = queue.withReloadSafety(async () => {
      assert.equal(queue.getSnapshot().items.some((item) => item.id === 'second'), true);
      return true;
    });
    assert.equal(await safe, true);
    await queue.drain();
    assert.equal(queue.getSnapshot().items[0]?.state, 'queued');
  } finally { await queue.dispose(); }
});

test('outbox safety waits for an outstanding durable mutation before applying', async () => {
  let finishWrite!: () => void;
  let startWrite!: () => void;
  const writing = new Promise<void>((resolve) => { startWrite = resolve; });
  const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
  let blocked = true;
  const queue = createOutboxRuntime({
    storage: {
      getItem: async () => null,
      setItem: async () => { if (blocked) { startWrite(); await pendingWrite; } },
    },
    canSend: () => false,
    deliver: async () => 'unused',
    discardAttachments: () => {},
  });
  try {
    await queue.load();
    const enqueue = queue.enqueue({ id: 'pending', agentId: 'agent', sessionId: 'thread', createsSession: false, text: 'Keep me', attachments: [] });
    await writing;
    let applied = false;
    const applying = queue.withReloadSafety(async () => {
      applied = true;
      assert.equal(queue.getSnapshot().items[0]?.id, 'pending');
      return false;
    });
    await Promise.resolve();
    assert.equal(applied, false);
    blocked = false;
    finishWrite();
    await enqueue;
    assert.equal(await applying, false);
    assert.equal(applied, true);
  } finally { await queue.dispose(); }
});

test('outbox safety refuses failed storage and releases delivery after a skipped reload', async () => {
  let fail = false;
  const queue = createOutboxRuntime({
    storage: { getItem: async () => null, setItem: async () => { if (fail) throw new Error('disk full'); } },
    canSend: () => false,
    deliver: async () => 'unused',
    discardAttachments: () => {},
  });
  try {
    await queue.load();
    fail = true;
    await assert.rejects(queue.withReloadSafety(async () => { assert.fail('storage failed'); }));
    fail = false;
    assert.equal(await queue.withReloadSafety(async () => false), false);
    assert.equal(await queue.withReloadSafety(async () => true), true);
    assert.equal(await queue.withReloadSafety(async () => { assert.fail('duplicate reload'); }), false);
  } finally { await queue.dispose(); }
});

test('outbox mutations queued behind a successful reload cannot write after authorization', async () => {
  let finishApply!: (applied: boolean) => void;
  let startApply!: () => void;
  const applying = new Promise<void>((resolve) => { startApply = resolve; });
  const pendingApply = new Promise<boolean>((resolve) => { finishApply = resolve; });
  let writes = 0;
  const queue = createOutboxRuntime({
    storage: { getItem: async () => null, setItem: async () => { writes += 1; } },
    canSend: () => false,
    deliver: async () => 'unused',
    discardAttachments: () => {},
  });
  try {
    await queue.enqueue({ id: 'keep', agentId: 'agent', sessionId: 'thread', createsSession: false, text: 'Keep me', attachments: [] });
    const reload = queue.withReloadSafety(async () => { startApply(); return pendingApply; });
    await applying;
    const pending = [
      queue.enqueue({ id: 'late', agentId: 'agent', sessionId: 'thread', createsSession: false, text: 'Late message', attachments: [] }),
      queue.retry('keep'), queue.remove('keep'), queue.forgetAgent('agent'),
    ];
    const rejected = pending.map((operation) => assert.rejects(operation, /restarting/));
    const storedWrites = writes;
    finishApply(true);
    assert.equal(await reload, true);
    await Promise.all(rejected);
    assert.equal(writes, storedWrites);
    assert.equal(queue.getSnapshot().items[0]?.id, 'keep');
  } finally { await queue.dispose(); }
});
