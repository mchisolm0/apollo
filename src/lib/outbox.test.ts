import assert from 'node:assert/strict';
import test from 'node:test';

import { canReplayMessage, createOutboxRuntime, decodeOutbox, type OutboxDependencies, type QueuedMessage } from './outbox.ts';

const first = { id: 'message-one', agentId: 'agent-one', sessionId: 'thread-one', createsSession: false, text: 'Do the work', attachments: [] };

test('steer reserves a queued message and removes it only after acceptance', async () => {
  let release!: () => void;
  let entered!: () => void;
  let canSend = false;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const accepted = new Promise<void>((resolve) => { release = resolve; });
  const setup = fixture({ canSend: () => canSend, steer: async (message, runId) => {
    assert.equal(message.id, first.id);
    assert.equal(runId, 'active-run');
    entered();
    await accepted;
  } });
  const outbox = createOutboxRuntime(setup.dependencies);
  try {
    await outbox.enqueue(first);
    const steering = outbox.steer(first.id, 'active-run');
    await started;
    assert.equal(outbox.getSnapshot().items[0]?.state, 'sending');
    canSend = true;
    await outbox.drain();
    assert.deepEqual(setup.sent, []);
    await assert.rejects(outbox.steer(first.id, 'active-run'), /Only queued/);
    release();
    await steering;
    assert.deepEqual(outbox.getSnapshot().items, []);
    await outbox.enqueue(first);
    await outbox.drain();
    assert.deepEqual(setup.sent, []);
  } finally { release(); await outbox.dispose(); }
});

test('failed steer keeps text queued with an error', async () => {
  const setup = fixture({ canSend: () => false, steer: async () => { throw new Error('Run ended'); } });
  const outbox = createOutboxRuntime(setup.dependencies);
  try {
    await outbox.enqueue(first);
    await assert.rejects(outbox.steer(first.id, 'ended-run'), /Message kept queued/);
    const message = outbox.getSnapshot().items[0];
    assert.equal(message?.text, first.text);
    assert.equal(message?.state, 'queued');
    assert.equal(message?.error, 'Could not steer. Message kept queued.');
  } finally { await outbox.dispose(); }
});

test('accepted steer survives a failed receipt write without becoming a normal turn', async () => {
  let writesFail = false;
  let stored: string | null = null;
  let requests = 0;
  const setup = fixture({
    canSend: () => false,
    storage: { getItem: async () => stored, setItem: async (_, value) => {
      if (writesFail) throw new Error('Disk full');
      stored = value;
    } },
    steer: async () => { requests++; writesFail = true; },
  });
  const outbox = createOutboxRuntime(setup.dependencies);
  try {
    await outbox.enqueue(first);
    await assert.rejects(outbox.steer(first.id, 'accepted-run'));
    assert.equal(outbox.getSnapshot().items[0]?.acceptedRunId, 'accepted-run');
    assert.equal(outbox.getSnapshot().items[0]?.state, 'queued');
    writesFail = false;
    setup.advance(31_000);
    await outbox.drain();
    assert.equal(requests, 1);
    assert.deepEqual(setup.sent, []);
    assert.deepEqual(outbox.getSnapshot().items, []);
  } finally { await outbox.dispose(); }
});

test('steer refuses attachments, skill instructions, and messages awaiting session creation', async () => {
  let requests = 0;
  const setup = fixture({ canSend: () => false, steer: async () => { requests++; } });
  const outbox = createOutboxRuntime(setup.dependencies);
  try {
    for (const patch of [
      { createsSession: true }, { instructions: 'Load skill' },
      { attachments: [{ id: 'file', name: 'a.txt', mimeType: 'text/plain', size: 1, uri: 'file:///a.txt' }] },
    ]) {
      await outbox.enqueue({ ...first, ...patch });
      await assert.rejects(outbox.steer(first.id, 'run'), /Only queued/);
      await outbox.remove(first.id);
    }
    assert.equal(requests, 0);
  } finally { await outbox.dispose(); }
});

test('forgetting aborts delivery and waits for the attachment reader before cleanup', async () => {
  let aborted = false;
  let discarded = false;
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const reading = new Promise<void>((resolve) => { release = resolve; });
  const setup = fixture({
    deliver: async (_, checkpoint, signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      started();
      await reading;
      if (signal.aborted) throw new Error('Cancelled');
      await checkpoint({ acceptedRunId: 'unexpected' });
      return 'unexpected';
    },
    discardAttachments: () => { discarded = true; },
  });
  const outbox = createOutboxRuntime(setup.dependencies);
  await outbox.enqueue(first);
  const delivery = outbox.drain();
  await entered;
  await outbox.forgetAgent(first.agentId);
  assert.equal(aborted, true);
  assert.equal(discarded, false);
  release();
  await delivery;
  assert.equal(discarded, true);
  assert.deepEqual(outbox.getSnapshot().items, []);
  assert.deepEqual(JSON.parse(setup.stored()!).completed, []);
  await outbox.dispose();
});

test('a backward clock requires review before replaying an ambiguous send', () => {
  const message: QueuedMessage = { ...first, createdAt: 1000, firstAttemptAt: 1000, state: 'queued', attempts: 1 };
  assert.equal(canReplayMessage(message, 999), false);
  assert.equal(canReplayMessage({ ...message, acceptedRunId: 'accepted' }, 999), true);
});

test('receipt compaction preserves stale drafts and keeps all receipts when drafts cannot be read', async () => {
  for (const unreadable of [false, true]) {
    const completed = [first.id, ...Array.from({ length: 256 }, (_, i) => `old-${i}`)];
    let stored = JSON.stringify({ items: [], completed });
    const setup = fixture({
      storage: { getItem: async () => stored, setItem: async (_, value) => { stored = value; } },
      referencedMessageIds: async () => { if (unreadable) throw new Error('unreadable draft'); return [first.id]; },
    });
    const outbox = createOutboxRuntime(setup.dependencies);
    await outbox.enqueue(first);
    await outbox.drain();
    assert.deepEqual(setup.sent, []);
    assert.deepEqual(JSON.parse(stored).completed, unreadable ? completed : [first.id]);
    await outbox.dispose();
  }
});

test('forgetting an agent discards its queued attachments after persistence', async () => {
  const discarded: string[] = [];
  const file = { id: 'attachment', name: 'a.txt', mimeType: 'text/plain', size: 2, uri: 'file:///a.txt' };
  const setup = fixture({ canSend: () => false, discardAttachments: (files) => discarded.push(...files.map((entry) => entry.id)) });
  const outbox = createOutboxRuntime(setup.dependencies);
  await outbox.enqueue({ ...first, attachments: [file] });
  await outbox.enqueue({ ...first, id: 'other', agentId: 'other-agent' });
  await outbox.forgetAgent(first.agentId);
  assert.deepEqual(discarded, [file.id]);
  assert.deepEqual(decodeOutbox(setup.stored()).map((entry) => entry.id), ['other']);
  await outbox.dispose();
});

function fixture(overrides: Partial<OutboxDependencies> = {}) {
  let stored: string | null = null;
  let now = 1000;
  const sent: string[] = [];
  const dependencies: OutboxDependencies = {
    storage: { getItem: async () => stored, setItem: async (_, value) => { stored = value; } },
    canSend: () => true,
    deliver: async (message) => { sent.push(message.id); return `run-${message.id}`; },
    discardAttachments: () => {},
    now: () => now,
    ...overrides,
  };
  return { dependencies, sent, stored: () => stored, advance: (ms: number) => { now += ms; } };
}

test('persists offline messages and reuses their identity after restart', async () => {
  let online = false;
  const setup = fixture({ canSend: () => online });
  const original = createOutboxRuntime(setup.dependencies);
  await original.enqueue(first);
  await original.drain();
  assert.deepEqual(setup.sent, []);
  assert.equal(decodeOutbox(setup.stored())[0].id, first.id);
  await original.dispose();

  online = true;
  const restored = createOutboxRuntime(setup.dependencies);
  await restored.drain();
  assert.deepEqual(setup.sent, [first.id]);
  assert.deepEqual(restored.getSnapshot().items, []);
  await restored.dispose();
});

test('blocks later messages in a failed thread while another thread can send', async () => {
  const sent: string[] = [];
  const setup = fixture({ deliver: async (message) => {
    sent.push(message.id);
    if (message.id === first.id) throw Object.assign(new Error('Access revoked'), { status: 401 });
    return 'accepted';
  } });
  const outbox = createOutboxRuntime(setup.dependencies);
  await outbox.enqueue(first);
  await outbox.enqueue({ ...first, id: 'message-two' });
  await outbox.enqueue({ ...first, id: 'message-three', sessionId: 'another-thread' });
  await Promise.all([outbox.drain(), outbox.drain()]);
  assert.deepEqual(sent.sort(), ['message-one', 'message-three']);
  assert.equal(outbox.getSnapshot().items[0].state, 'failed');
  await outbox.remove(first.id);
  await outbox.drain();
  assert.equal(sent.at(-1), 'message-two');
  await outbox.dispose();
});

test('retries ambiguous delivery with the same key, but stops before server retention expires', async () => {
  const keys: string[] = [];
  const setup = fixture({ deliver: async (message) => { keys.push(message.id); throw new Error('Connection lost'); } });
  const outbox = createOutboxRuntime(setup.dependencies);
  await outbox.enqueue(first);
  await outbox.drain();
  setup.advance(3000);
  await outbox.drain();
  assert.deepEqual(keys, [first.id, first.id]);
  setup.advance(24 * 60 * 60 * 1000);
  await outbox.drain();
  assert.equal(outbox.getSnapshot().items[0].state, 'failed');
  await assert.rejects(outbox.retry(first.id), /Check this thread/);
  assert.equal(keys.length, 2);
  await outbox.dispose();
});

test('a failed durable write never delivers or reports an enqueued message', async () => {
  const setup = fixture({ storage: { getItem: async () => null, setItem: async () => { throw new Error('Disk full'); } } });
  const outbox = createOutboxRuntime(setup.dependencies);
  await assert.rejects(outbox.enqueue(first));
  await outbox.drain();
  assert.deepEqual(outbox.getSnapshot().items, []);
  assert.deepEqual(setup.sent, []);
  await outbox.dispose();
});

test('an accepted checkpoint survives a later failure without resending', async () => {
  let calls = 0;
  const setup = fixture({ deliver: async (_, checkpoint) => {
    calls++;
    await checkpoint({ acceptedRunId: 'accepted-run' });
    throw new Error('Lost local acknowledgement');
  } });
  const outbox = createOutboxRuntime(setup.dependencies);
  await outbox.enqueue(first);
  await outbox.drain();
  await outbox.dispose();
  setup.advance(3000);
  const restored = createOutboxRuntime(setup.dependencies);
  await restored.drain();
  assert.equal(calls, 1);
  assert.deepEqual(restored.getSnapshot().items, []);
  await restored.dispose();
});

test('does not overwrite unreadable saved messages and recovers an interrupted send', async () => {
  assert.throws(() => decodeOutbox('[{"id":"incomplete"}]'));
  const interrupted: QueuedMessage = { ...first, createdAt: 1000, attempts: 1, firstAttemptAt: 1000, state: 'sending' };
  assert.equal(decodeOutbox(JSON.stringify([interrupted]))[0].state, 'queued');
  let wrote = false;
  const setup = fixture({ storage: { getItem: async () => 'corrupted', setItem: async () => { wrote = true; } } });
  const outbox = createOutboxRuntime(setup.dependencies);
  await assert.rejects(outbox.enqueue(first));
  assert.equal(wrote, false);
  assert.equal(outbox.getSnapshot().loaded, false);
  await outbox.dispose();
});

// A stale prepared draft may survive a crash after delivery or a failed draft-clear write.
test('a delivered draft cannot enqueue again after restart and upstream expiry', async () => {
  const setup = fixture();
  const original = createOutboxRuntime(setup.dependencies);
  await original.enqueue(first);
  await original.drain();
  await original.dispose();
  setup.advance(48 * 60 * 60 * 1000);
  const restored = createOutboxRuntime(setup.dependencies);
  await restored.enqueue(first);
  await restored.drain();
  assert.deepEqual(setup.sent, [first.id]);
  assert.deepEqual(restored.getSnapshot().items, []);
  await restored.dispose();
});


test('restores the selected model and skill instructions with a queued message', async () => {
  const setup = fixture({ canSend: () => false });
  const original = createOutboxRuntime(setup.dependencies);
  await original.enqueue({ ...first, model: 'provider/model', instructions: 'Use the selected skill.' });
  const restored = decodeOutbox(setup.stored())[0];
  assert.equal(restored.model, 'provider/model');
  assert.equal(restored.instructions, 'Use the selected skill.');
  assert.throws(() => decodeOutbox(JSON.stringify([{ ...restored, model: 42 }])));
  await original.dispose();
});
