import assert from 'node:assert/strict';
import test from 'node:test';

import type { Card } from '../../../cloud/src/contract.ts';
import { createRespondQueue, type QueuedResponse } from './respond-queue.ts';

const card: Card = { id: 'card_1', rev: 3, source: 'morning', key: '2026-10-09', kind: 'briefing', title: 'Morning', push: 'alert', state: 'open', createdAt: '2026-10-09T08:00:00Z', updatedAt: '2026-10-09T08:00:00Z' };

function fixture(send: (item: QueuedResponse) => Promise<Card>, options: { failWrites?: () => boolean } = {}) {
  let stored: string | null = null;
  let clock = 1_000;
  const sent: QueuedResponse[] = [];
  const queue = createRespondQueue({
    storage: { getItem: async () => stored, setItem: async (_, value) => {
      if (options.failWrites?.()) throw new Error('Disk full');
      stored = value;
    } },
    send: async (item) => { sent.push(item); return send(item); },
    now: () => clock,
  });
  return { queue, sent, stored: () => stored, advance: (ms: number) => { clock += ms; } };
}

const offline = () => Promise.reject(new Error('Network request failed'));

test('offline responses persist, keep their key, and deliver in order once back online', async () => {
  let online = false;
  const setup = fixture(async () => online ? card : offline());
  await setup.queue.enqueue({ key: 'k1', cardId: 'card_1', response: { pick: 1, done: true } });
  await setup.queue.enqueue({ key: 'k2', cardId: 'card_1', response: { actionId: 'keep' } });
  await setup.queue.flush();
  assert.deepEqual(setup.queue.getSnapshot().items.map((item) => [item.key, item.attempts]), [['k1', 1], ['k2', 0]]);
  assert.match(setup.stored() ?? '', /k2/);

  online = true;
  setup.advance(60_000);
  await setup.queue.flush();
  assert.deepEqual(setup.sent.map((item) => item.key), ['k1', 'k1', 'k2']);
  assert.deepEqual(setup.queue.getSnapshot().items, []);
});

test('a later response for a card waits behind a backing-off head while other cards proceed', async () => {
  let online = false;
  const setup = fixture(async (item) => online || item.cardId === 'card_2' ? card : offline());
  await setup.queue.enqueue({ key: 'pick', cardId: 'card_1', response: { pick: 1, done: true } });
  await setup.queue.enqueue({ key: 'keep', cardId: 'card_1', response: { actionId: 'keep' } });
  await setup.queue.enqueue({ key: 'other', cardId: 'card_2', response: { actionId: 'approve' } });
  await setup.queue.flush();
  assert.deepEqual(setup.sent.map((item) => item.key), ['pick', 'other']);
  assert.deepEqual(setup.queue.getSnapshot().items.map((item) => item.key), ['pick', 'keep']);
  online = true;
  setup.advance(60_000);
  await setup.queue.flush();
  assert.deepEqual(setup.sent.map((item) => item.key), ['pick', 'other', 'pick', 'keep']);
});

test('toggles coalesce so only the latest value is sent, with a new key only when the body changes', async () => {
  let online = false;
  const setup = fixture(async () => online ? card : offline());
  await setup.queue.enqueue({ key: 'on', cardId: 'card_1', response: { pick: 1, done: true } });
  await setup.queue.flush();
  // The first toggle is backing off at the head when the user flips it back, twice.
  await setup.queue.enqueue({ key: 'off', cardId: 'card_1', response: { pick: 1, done: false } });
  await setup.queue.enqueue({ key: 'off-again', cardId: 'card_1', response: { pick: 1, done: false } });
  assert.deepEqual(setup.queue.getSnapshot().items.map((item) => [item.key, item.response]), [['off', { pick: 1, done: false }]]);
  online = true;
  setup.advance(60_000);
  await setup.queue.flush();
  assert.deepEqual(setup.sent.map((item) => [item.key, item.response.done]), [['on', true], ['off', false]]);
});

test('a toggle sent while an older one is in flight still ends on the latest value', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let firstAttempt = true;
  const setup = fixture(async () => {
    if (!firstAttempt) return card;
    firstAttempt = false;
    await gate;
    throw new Error('Network request failed');
  });
  await setup.queue.enqueue({ key: 'k1', cardId: 'card_1', response: { pick: 1, done: true } });
  const flushing = setup.queue.flush();
  await setup.queue.enqueue({ key: 'k2', cardId: 'card_1', response: { pick: 1, done: false } });
  release();
  await flushing;
  // k1 is backing off at the head, k2 waits behind it, and the user taps again.
  await setup.queue.enqueue({ key: 'k3', cardId: 'card_1', response: { pick: 1, done: true } });
  assert.deepEqual(setup.queue.getSnapshot().items.map((item) => [item.key, item.response.done]), [['k1', true], ['k3', true]]);
  setup.advance(60_000);
  await setup.queue.flush();
  assert.equal(setup.sent.at(-1)?.response.done, true);
  assert.deepEqual(setup.queue.getSnapshot().items, []);
});

test('401 pauses the queue without dropping it until credentials change', async () => {
  let revoked = true;
  const setup = fixture(async () => { if (revoked) throw Object.assign(new Error('Unauthorized'), { status: 401 }); return card; });
  await setup.queue.enqueue({ key: 'a', cardId: 'card_1', response: { actionId: 'keep' } });
  await setup.queue.enqueue({ key: 'b', cardId: 'card_2', response: { actionId: 'approve' } });
  await setup.queue.flush();
  assert.equal(setup.queue.getSnapshot().paused, true);
  assert.deepEqual(setup.queue.getSnapshot().items.map((item) => item.key), ['a', 'b']);
  assert.equal(setup.sent.length, 1);
  revoked = false;
  setup.queue.resume();
  await setup.queue.flush();
  assert.deepEqual(setup.queue.getSnapshot(), { items: [] });
});

test('a one-off 401 resumes in order once the same credentials work again, and resume is otherwise a no-op', async () => {
  let unauthorized = true;
  const setup = fixture(async (item) => {
    if (item.key === 'bad') throw Object.assign(new Error('Unknown card'), { status: 404 });
    if (unauthorized) { unauthorized = false; throw Object.assign(new Error('Unauthorized'), { status: 401 }); }
    return card;
  });
  await setup.queue.enqueue({ key: 'pick', cardId: 'card_1', response: { pick: 1, done: true } });
  await setup.queue.enqueue({ key: 'keep', cardId: 'card_1', response: { actionId: 'keep' } });
  await setup.queue.flush();
  assert.equal(setup.queue.getSnapshot().paused, true);
  // A successful snapshot with the same credentials calls resume.
  setup.queue.resume();
  await setup.queue.flush();
  assert.deepEqual(setup.sent.map((item) => item.key), ['pick', 'pick', 'keep']);
  await setup.queue.enqueue({ key: 'bad', cardId: 'missing', response: { actionId: 'approve' } });
  await setup.queue.flush();
  setup.queue.resume();
  assert.deepEqual(setup.queue.getSnapshot(), { items: [], error: 'Unknown card' });
});

test('an enqueue that cannot be saved is rejected and never shows as queued', async () => {
  const setup = fixture(offline, { failWrites: () => true });
  await assert.rejects(setup.queue.enqueue({ key: 'k', cardId: 'card_1', response: { actionId: 'approve' } }), /Disk full/);
  assert.deepEqual(setup.queue.getSnapshot().items, []);
});

test('a newer pick replaces an unsent one and duplicate keys collapse', async () => {
  const setup = fixture(offline);
  await setup.queue.enqueue({ key: 'a', cardId: 'card_1', response: { pick: 2, done: true } });
  await setup.queue.enqueue({ key: 'b', cardId: 'card_1', response: { pick: 2, done: false } });
  await setup.queue.enqueue({ key: 'b', cardId: 'card_1', response: { pick: 2, done: false } });
  await setup.queue.enqueue({ key: 'c', cardId: 'card_1', response: { pick: 3, done: true } });
  assert.deepEqual(setup.queue.getSnapshot().items.map((item) => [item.key, item.response]), [['b', { pick: 2, done: false }], ['c', { pick: 3, done: true }]]);
});

test('card_closed is handled with the server card, other 4xx drop with an error', async () => {
  const closed = { ...card, rev: 9, state: 'resolved' as const };
  const setup = fixture(async (item) => {
    if (item.key === 'late') throw Object.assign(new Error('Card is closed'), { status: 409, code: 'card_closed', card: closed });
    throw Object.assign(new Error('Unknown card'), { status: 404, code: 'not_found' });
  });
  const seen: Card[] = [];
  setup.queue.onCard((next) => seen.push(next));
  await setup.queue.enqueue({ key: 'late', cardId: 'card_1', response: { actionId: 'approve' } });
  await setup.queue.flush();
  assert.deepEqual(seen, [closed]);
  assert.equal(setup.queue.getSnapshot().error, undefined);

  await setup.queue.enqueue({ key: 'bad', cardId: 'missing', response: { actionId: 'approve' } });
  await setup.queue.flush();
  assert.deepEqual(setup.queue.getSnapshot(), { items: [], error: 'Unknown card' });
});

test('responses older than the idempotency window are not replayed', async () => {
  const setup = fixture(offline);
  await setup.queue.enqueue({ key: 'old', cardId: 'card_1', response: { actionId: 'approve' } });
  setup.advance(24 * 60 * 60 * 1000);
  await setup.queue.flush();
  assert.deepEqual(setup.queue.getSnapshot().items, []);
  assert.equal(setup.sent.length, 0);
});
