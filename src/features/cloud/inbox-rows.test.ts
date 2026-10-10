import assert from 'node:assert/strict';
import test from 'node:test';

import type { Card } from '../../../cloud/src/contract.ts';
import { buildInboxRows, withPendingResponses, type InboxRowSession } from './inbox-rows.ts';

function card(id: string, kind: Card['kind'], patch: Partial<Card> = {}): Card {
  return { id, rev: 1, source: 'preview', key: id, kind, title: id, push: 'alert', state: 'open', createdAt: '2026-10-09T08:00:00Z', updatedAt: '2026-10-09T08:00:00Z', ...patch };
}

function session(id: string, patch: Partial<InboxRowSession> = {}): InboxRowSession {
  return { id, title: id, settled: false, status: 'active', pendingApproval: false, ...patch };
}

const collapsed = { updates: true, snoozed: true, settled: true };
const layout = (rows: ReturnType<typeof buildInboxRows>) => rows.map((row) => row.kind === 'section' ? `[${row.title} ${row.count}]` : `${row.kind}:${row.id}`);

test('design C order: morning card, Needs you, threads, then collapsed sections', () => {
  const rows = buildInboxRows({
    sessions: [session('waiting', { pendingApproval: true, status: 'attention' }), session('thread'), session('later'), session('done', { settled: true })],
    cards: [
      card('morning', 'briefing', { source: 'morning' }),
      card('preview', 'approval'),
      card('hermes-approval', 'approval', { source: 'hermes' }),
      card('resolved', 'approval', { state: 'resolved' }),
      card('build', 'update', { source: 'fleet' }),
      card('jobs', 'update', { source: 'jobs', updatedAt: '2026-10-09T09:00:00Z' }),
    ],
    isSnoozed: (id) => id === 'later',
    collapsed,
  });
  assert.deepEqual(layout(rows), ['briefing:morning', '[Needs you 2]', 'card:preview', 'session:waiting', '[Threads 1]', 'session:thread', '[Updates 2]', '[Snoozed 1]', '[Settled 1]']);
  const open = buildInboxRows({ sessions: [], cards: [card('build', 'update'), card('jobs', 'update', { updatedAt: '2026-10-09T09:00:00Z' })], isSnoozed: () => false, collapsed: { ...collapsed, updates: false } });
  assert.deepEqual(layout(open), ['[Updates 2]', 'card:jobs', 'card:build']);
});

test('without cards the inbox is the plain thread list', () => {
  const rows = buildInboxRows({ sessions: [session('a'), session('b')], cards: [], isSnoozed: () => false, collapsed });
  assert.deepEqual(layout(rows), ['session:a', 'session:b']);
});

test('search and the attention filter hide the morning card and narrow cards', () => {
  const input = {
    sessions: [session('quiet'), session('new result', { status: 'attention' as const })],
    cards: [card('morning', 'briefing'), card('Scryve preview', 'approval'), card('disk', 'update', { body: 'mini low on disk' })],
    isSnoozed: () => false,
    collapsed,
  };
  assert.deepEqual(layout(buildInboxRows({ ...input, attentionOnly: true })), ['[Needs you 1]', 'card:Scryve preview', '[Threads 1]', 'session:new result']);
  assert.deepEqual(layout(buildInboxRows({ ...input, query: 'disk' })), ['[Updates 1]', 'card:disk']);
});

test('queued responses show right away: picks flip, an approval says so, a morning card stays acknowledged', () => {
  const morning = card('morning', 'briefing', { picks: [{ n: 1, text: 'Merge', done: false }, { n: 2, text: 'Review', done: false }] });
  const cards = withPendingResponses([morning, card('preview', 'approval')], [
    { cardId: 'morning', response: { pick: 2, done: true } },
    { cardId: 'preview', response: { actionId: 'approve' } },
    { cardId: 'morning', response: { actionId: 'keep' } },
  ]);
  assert.deepEqual(cards[0].picks?.map((pick) => pick.done), [false, true]);
  assert.equal(cards[0].acknowledged, 'keep');
  assert.equal(cards[0].pendingAction, undefined);
  assert.equal(cards[1].pendingAction, 'approve');
  const rows = buildInboxRows({ sessions: [], cards, isSnoozed: () => false, collapsed });
  assert.deepEqual(layout(rows), ['briefing:morning', '[Needs you 1]', 'card:preview']);
  // Once delivered, the server's resolution (first answer, possibly from another device) wins.
  const resolved = { ...morning, resolution: { actionId: 'skip', by: 'ipad', at: '2026-10-09T08:05:00Z' } };
  assert.equal(withPendingResponses([resolved], [])[0].acknowledged, 'skip');
  assert.equal(withPendingResponses([resolved], [{ cardId: 'morning', response: { actionId: 'keep' } }])[0].acknowledged, 'skip');
});
