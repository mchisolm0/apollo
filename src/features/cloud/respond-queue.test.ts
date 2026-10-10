import assert from 'node:assert/strict';
import test from 'node:test';

import type { Card } from '../../../cloud/src/contract.ts';
import { createRespondQueue, type QueuedResponse } from './respond-queue.ts';

const card: Card = { id: 'card_1', rev: 3, source: 'morning', key: '2026-10-09', kind: 'briefing', title: 'Morning', push: 'alert', state: 'open', createdAt: '2026-10-09T08:00:00Z', updatedAt: '2026-10-09T08:00:00Z' };

function fixture(send: (item: QueuedResponse) => Promise<Card>) {
  let stored: string | null = null;
  let clock = 1_000;
  const sent: QueuedResponse[] = [];
  const queue = createRespondQueue({
    storage: { getItem: async () => stored, setItem: async (_, value) => { stored = value; } },
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
