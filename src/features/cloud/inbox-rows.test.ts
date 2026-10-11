import assert from 'node:assert/strict';
import test from 'node:test';

import type { Card } from '../../../cloud/src/contract.ts';
import { buildInboxRows, cardOpenPlan, hermesApprovalTarget, settleAction, settleOnFirstSight, updateSettledCards, withPendingResponses, type InboxRowSession } from './inbox-rows.ts';

function card(id: string, kind: Card['kind'], patch: Partial<Card> = {}): Card {
  return { id, rev: 1, source: 'preview', key: id, kind, title: id, push: 'alert', state: 'open', createdAt: '2026-10-09T08:00:00Z', updatedAt: '2026-10-09T08:00:00Z', ...patch };
}

function session(id: string, patch: Partial<InboxRowSession> = {}): InboxRowSession {
  return { id, title: id, settled: false, status: 'active', pendingApproval: false, activityAt: 0, ...patch };
}

const collapsed = { snoozed: true, settled: true };
const layout = (rows: ReturnType<typeof buildInboxRows>) => rows.map((row) => row.kind === 'section' ? `[${row.title} ${row.count}]` : `${row.kind}:${row.id}`);
const at = (hour: number) => `2026-10-10T${String(hour).padStart(2, '0')}:00:00Z`;

test('cards come first: morning card, approvals, waiting threads, updates newest first, then other threads', () => {
  const rows = buildInboxRows({
    sessions: [session('thread', { status: 'attention' }), session('waiting', { pendingApproval: true, status: 'attention' }), session('later'), session('done', { settled: true, activityAt: Date.parse(at(9)) / 1000 })],
    cards: [
      card('morning', 'briefing', { source: 'morning' }),
      card('preview', 'approval'),
      card('hermes-approval', 'approval', { source: 'hermes' }),
      card('build', 'update', { source: 'fleet', updatedAt: at(7) }),
      card('jobs', 'update', { source: 'jobs', updatedAt: at(8) }),
    ],
    isSnoozed: (id) => id === 'later',
    collapsed,
  });
  assert.deepEqual(layout(rows), ['briefing:morning', 'card:preview', 'card:hermes-approval', 'session:waiting', 'card:jobs', 'card:build', 'session:thread', '[Snoozed 1]', '[Settled 1]']);
});

test('Settled mixes settled threads with closed and locally settled cards, newest first', () => {
  const rows = buildInboxRows({
    sessions: [session('old thread', { settled: true, activityAt: Date.parse(at(6)) / 1000 })],
    cards: [
      card('approved', 'approval', { state: 'resolved', updatedAt: at(9) }),
      card('swiped', 'update', { updatedAt: at(7) }),
      card('open', 'update', { updatedAt: at(8) }),
      card('old morning', 'briefing', { state: 'settled', updatedAt: at(5) }),
    ],
    settledCards: new Map([['swiped', 1]]),
    isSnoozed: () => false,
    collapsed: { ...collapsed, settled: false },
  });
  assert.deepEqual(layout(rows), ['card:open', '[Settled 4]', 'card:approved', 'card:swiped', 'session:old thread', 'card:old morning']);
  assert.deepEqual(rows.filter((row) => row.kind === 'card').map((row) => row.kind === 'card' && row.settled), [false, true, true, true]);
});

test('a settled card resurfaces when the producer re-upserts it with a newer rev', () => {
  const digest = card('digest', 'update', { rev: 5 });
  const settled = updateSettledCards(new Map(), [digest, card('gone', 'update', { rev: 2 })], 'digest', true);
  assert.deepEqual([...settled], [['digest', 5]]);
  const input = { sessions: [], isSnoozed: () => false, settledCards: settled, collapsed: { ...collapsed, settled: false } };
  assert.deepEqual(layout(buildInboxRows({ ...input, cards: [digest] })), ['[Settled 1]', 'card:digest']);
  assert.deepEqual(layout(buildInboxRows({ ...input, cards: [{ ...digest, rev: 9 }] })), ['card:digest']);
  // Reopening removes it, and entries for cards that left the inbox are dropped.
  assert.deepEqual([...updateSettledCards(new Map([['digest', 5], ['gone', 2]]), [digest], 'digest', false)], []);
});

test('an open approval cannot be swiped away; others settle, and locally settled ones reopen', () => {
  const none = new Map<string, number>();
  assert.equal(settleAction(card('a', 'approval'), none), undefined);
  assert.equal(settleAction(card('u', 'update'), none), 'settle');
  assert.equal(settleAction(card('b', 'briefing'), none), 'settle');
  assert.equal(settleAction(card('u', 'update'), new Map([['u', 1]])), 'reopen');
  assert.equal(settleAction(card('r', 'approval', { state: 'resolved' }), none), undefined);
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
  assert.deepEqual(layout(buildInboxRows({ ...input, attentionOnly: true })), ['card:Scryve preview', 'session:new result']);
  assert.deepEqual(layout(buildInboxRows(input)), ['briefing:morning', 'card:Scryve preview', 'card:disk', 'session:quiet', 'session:new result']);
  assert.deepEqual(layout(buildInboxRows({ ...input, query: 'disk' })), ['card:disk']);
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
  assert.deepEqual(layout(rows), ['briefing:morning', 'card:preview']);
  // Once delivered, the server's resolution (first answer, possibly from another device) wins.
  const resolved = { ...morning, resolution: { actionId: 'skip', by: 'ipad', at: '2026-10-09T08:05:00Z' } };
  assert.equal(withPendingResponses([resolved], [])[0].acknowledged, 'skip');
  assert.equal(withPendingResponses([resolved], [{ cardId: 'morning', response: { actionId: 'keep' } }])[0].acknowledged, 'skip');
});

test('opening an update settles it and a link-only update opens its link; approvals and morning cards stay', () => {
  assert.deepEqual(cardOpenPlan(card('u', 'update', { body: 'Digest' })), { target: 'detail', settle: true });
  assert.deepEqual(cardOpenPlan(card('p', 'update', { url: 'scryve-preview://preview/pr-376' })), { target: 'link', settle: true });
  assert.deepEqual(cardOpenPlan(card('a', 'approval', { url: 'https://x.dev' })), { target: 'detail', settle: false });
  assert.deepEqual(cardOpenPlan(card('b', 'briefing')), { target: 'detail', settle: false });
  // Once settled on open, the update leaves the open list and waits in Settled.
  const update = card('p', 'update', { rev: 4 });
  const settled = updateSettledCards(new Map(), [update], 'p', cardOpenPlan(update).settle);
  assert.deepEqual(layout(buildInboxRows({ sessions: [], cards: [update], settledCards: settled, isSnoozed: () => false, collapsed })), ['[Settled 1]']);
});

test('a detail screen settles an update once, the first time it sees it, so Reopen sticks', () => {
  const update = card('u', 'update', { rev: 3 });
  const settled = new Map([['u', 3]]);
  // Opened from a row that already settled it: decided as seen, nothing more to do.
  let step = settleOnFirstSight(undefined, update, settled);
  assert.deepEqual(step, { seen: 'u', settle: false });
  // The user reopens it on the screen; it must not be settled again.
  step = settleOnFirstSight(step.seen, update, new Map());
  assert.deepEqual(step, { seen: 'u', settle: false });
  // Opened fresh (from a notification): settles once, after the card loads.
  assert.deepEqual(settleOnFirstSight(undefined, undefined, new Map()), { seen: undefined, settle: false });
  assert.deepEqual(settleOnFirstSight(undefined, update, new Map()), { seen: 'u', settle: true });
  assert.deepEqual(settleOnFirstSight(undefined, card('a', 'approval'), new Map()), { seen: 'a', settle: false });
});

test('a Hermes approval from a run this phone did not start shows as an approval and opens its thread', () => {
  const approval = card('card:run_9:req_1', 'approval', { source: 'hermes', key: 'run_9:req_1', title: 'Allow git push?', url: 'apollo://session/session_9?agentId=mini&runId=run_9', actions: [{ id: 'approve', label: 'Approve', style: 'primary' }, { id: 'reject', label: 'Reject', style: 'destructive' }] });
  const rows = buildInboxRows({ sessions: [session('session_9'), session('other')], cards: [approval], isSnoozed: () => false, collapsed });
  assert.deepEqual(layout(rows), ['card:card:run_9:req_1', 'session:session_9', 'session:other']);
  assert.deepEqual(hermesApprovalTarget(approval), { sessionId: 'session_9', runId: 'run_9' });
  assert.deepEqual(cardOpenPlan(approval), { target: 'link', settle: false });
  // Resolved elsewhere: it leaves, and does not pile up in Settled.
  assert.deepEqual(layout(buildInboxRows({ sessions: [], cards: [{ ...approval, state: 'resolved' }], isSnoozed: () => false, collapsed })), []);
});

test('a Hermes approval this phone already shows as a waiting thread is hidden behind the thread row', () => {
  const approval = card('card:run_9:req_1', 'approval', { source: 'hermes', key: 'run_9:req_1', url: 'apollo://session/session_9?agentId=mini&runId=run_9' });
  const bySession = buildInboxRows({ sessions: [session('session_9', { pendingApproval: true, status: 'attention' })], cards: [approval], isSnoozed: () => false, collapsed });
  assert.deepEqual(layout(bySession), ['session:session_9']);
  // Without a url, the run id from the key matches the phone's run state.
  const byRun = buildInboxRows({ sessions: [], cards: [{ ...approval, url: undefined }], pendingRunIds: new Set(['run_9']), isSnoozed: () => false, collapsed });
  assert.deepEqual(layout(byRun), []);
});
