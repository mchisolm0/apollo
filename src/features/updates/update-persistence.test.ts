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
