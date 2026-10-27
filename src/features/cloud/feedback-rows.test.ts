import assert from 'node:assert/strict';
import test from 'node:test';

import type { Card } from '../../../cloud/src/contract.ts';
import { feedbackRows } from './feedback-rows.ts';

function card(id: string, patch: Partial<Card> = {}): Card {
  return { id, rev: 1, source: 'feedback', key: id, kind: 'update', title: 'Idea: dark board', push: 'alert', state: 'open', createdAt: '2026-10-09T08:00:00Z', updatedAt: '2026-10-09T08:00:00Z', ...patch };
}

const cards = [
  card('old-bug', { title: 'Bug: crash', kind: 'approval', createdAt: '2026-10-01T08:00:00Z' }),
  card('idea'),
  card('new-bug', { title: 'Bug: sync', createdAt: '2026-10-20T08:00:00Z' }),
  card('preview', { source: 'preview', kind: 'approval' }),
];
const ids = (rows: readonly Card[]) => rows.map((row) => row.id);

test('lists only feedback, newest report first', () => {
  assert.deepEqual(ids(feedbackRows(cards, 'all')), ['new-bug', 'idea', 'old-bug']);
});

test('waiting means the player spoke last', () => {
  assert.deepEqual(ids(feedbackRows(cards, 'waiting')), ['old-bug']);
});

test('bugs and ideas split by title prefix', () => {
  assert.deepEqual(ids(feedbackRows(cards, 'bugs')), ['new-bug', 'old-bug']);
  assert.deepEqual(ids(feedbackRows(cards, 'ideas')), ['idea']);
});
