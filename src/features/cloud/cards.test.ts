import assert from 'node:assert/strict';
import test from 'node:test';

import type { Card } from '../../../cloud/src/contract.ts';
import { applyStreamMessage, cloudNotificationIntent, mergeSnapshot, parseCard, parseStreamMessage } from './cards.ts';

function card(id: string, rev: number, patch: Partial<Card> = {}): Card {
  return { id, rev, source: 'preview', key: id, kind: 'approval', title: id, push: 'alert', state: 'open', createdAt: '2026-10-09T08:00:00Z', updatedAt: '2026-10-09T08:00:00Z', ...patch };
}

test('a stream update that lands while the snapshot is in flight survives the merge', () => {
  // Stream opened first, then GET was sent. The snapshot was read at rev 10.
  let local = applyStreamMessage([card('a', 4)], { type: 'card', card: card('a', 12, { state: 'resolved' }) });
  local = applyStreamMessage(local, { type: 'card', card: card('new', 11) });
  const merged = mergeSnapshot(local, { rev: 10, cards: [card('a', 9), card('b', 7)] });
  assert.deepEqual(merged.map((item) => [item.id, item.rev, item.state]).sort(), [['a', 12, 'resolved'], ['b', 7, 'open'], ['new', 11, 'open']]);
});

test('a snapshot drops local cards it no longer holds, including approvals that aged out', () => {
  // Resolved at rev 5, then left the 7-day window, so the snapshot omits it even though nothing newer touched it.
  const merged = mergeSnapshot([card('old-approval', 5, { state: 'resolved' }), card('kept', 3)], { rev: 40, cards: [card('kept', 3)] });
  assert.deepEqual(merged.map((item) => item.id), ['kept']);
  assert.deepEqual(mergeSnapshot([card('gone', 9)], { rev: 9, cards: [] }), []);
});

test('the stream never downgrades a card and removals during a fetch stick', () => {
  const cards = [card('a', 8)];
  assert.equal(applyStreamMessage(cards, { type: 'card', card: card('a', 7, { title: 'stale' }) }), cards);
  assert.deepEqual(mergeSnapshot([], { rev: 20, cards: [card('removed', 15)] }, new Set(['removed'])), []);
  assert.deepEqual(parseStreamMessage(JSON.stringify({ type: 'remove', id: 'x' })), { type: 'remove', id: 'x' });
  assert.equal(parseStreamMessage('pong'), undefined);
});

test('card parsing rejects malformed rows and drops unknown fields', () => {
  assert.equal(parseCard({ ...card('a', 1), source: 'discord' }), undefined);
  assert.equal(parseCard({ ...card('a', 1), rev: '1' }), undefined);
  const parsed = parseCard({ ...card('a', 1), extra: true, picks: [{ n: 1, text: 'Merge', done: false }, { n: 'two' }], meta: { calendar: '10:00', bad: 3 } });
  assert.deepEqual(parsed?.picks, [{ n: 1, text: 'Merge', done: false }]);
  assert.deepEqual(parsed?.meta, { calendar: '10:00' });
  assert.equal(parsed && 'extra' in parsed, false);
});

test('only approval notifications answer from the lock screen, with a stable key', () => {
  const response = (actionIdentifier: string, categoryIdentifier: string, data: unknown = { cardId: 'card_1', source: 'preview', kind: 'approval' }) =>
    ({ actionIdentifier, notification: { request: { identifier: 'n1', content: { data, categoryIdentifier } } } });
  assert.deepEqual(cloudNotificationIntent(response('approve', 'apollo.approval')), { type: 'respond', cardId: 'card_1', actionId: 'approve', key: 'notification:n1:approve' });
  assert.equal(cloudNotificationIntent(response('approve', 'apollo.briefing', { cardId: 'card_1', kind: 'briefing' })), undefined);
  assert.deepEqual(cloudNotificationIntent(response('expo.modules.notifications.actions.DEFAULT', 'apollo.briefing', { cardId: 'card_2', kind: 'briefing' })), { type: 'open', cardId: 'card_2', kind: 'briefing' });
  assert.equal(cloudNotificationIntent(response('approve', 'apollo.approval', { kind: 'approval', run_id: 'r' })), undefined);
});

test('the push registration key changes with a re-minted token and never contains it', async () => {
  const { pushRegistrationKey } = await import('./cloud-client.ts');
  const credential = { url: 'https://inbox.example', agentId: 'agent_1', token: 'device-token-one' };
  const key = pushRegistrationKey(credential, 'ExponentPushToken[abc]');
  assert.equal(pushRegistrationKey({ ...credential }, 'ExponentPushToken[abc]'), key);
  assert.notEqual(pushRegistrationKey({ ...credential, token: 'device-token-two' }, 'ExponentPushToken[abc]'), key);
  assert.equal(key.includes(credential.token), false);
});
