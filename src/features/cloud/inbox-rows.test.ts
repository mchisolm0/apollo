import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, mock } from 'node:test';

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

beforeEach(() => mock.timers.enable({ apis: ['Date'], now: Date.parse(at(12)) }));
afterEach(() => mock.timers.reset());

test('morning and approvals stay first; open updates and threads interleave by activity', () => {
  const rows = buildInboxRows({
    sessions: [session('thread', { status: 'attention', activityAt: Date.parse(at(9)) / 1000 }), session('middle', { activityAt: Date.parse(at(7)) / 1000 + 1 }), session('waiting', { pendingApproval: true, status: 'attention' }), session('later'), session('done', { settled: true, activityAt: Date.parse(at(9)) / 1000 })],
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
  assert.deepEqual(layout(rows), ['briefing:morning', 'card:preview', 'card:hermes-approval', 'session:waiting', 'session:thread', 'card:jobs', 'session:middle', 'card:build', '[Snoozed 1]', '[Settled 1]']);
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
  assert.deepEqual(layout(buildInboxRows({ ...input, cards: [digest] })), ['caughtUp:caught-up', '[Settled 1]', 'card:digest']);
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

test('attention keeps the open morning card, approvals and waiting threads; search narrows cards', () => {
  const input = {
    sessions: [session('quiet'), session('new result', { status: 'attention' as const }), session('waiting', { pendingApproval: true })],
    cards: [card('morning', 'briefing'), card('Scryve preview', 'approval'), card('disk', 'update', { body: 'mini low on disk' })],
    isSnoozed: () => false,
    collapsed,
  };
  assert.deepEqual(layout(buildInboxRows({ ...input, attentionOnly: true })), ['briefing:morning', 'card:Scryve preview', 'session:waiting', 'session:new result']);
  assert.deepEqual(layout(buildInboxRows(input)), ['briefing:morning', 'card:Scryve preview', 'session:waiting', 'card:disk', 'session:quiet', 'session:new result']);
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

test('a queued repeat action shows as sending without answering the card', () => {
  const feedback = card('f', 'approval', { source: 'feedback', actions: [{ id: 'reply', label: 'Reply', input: 'text', repeat: true }, { id: 'publish', label: 'Publish' }] });
  const [sending] = withPendingResponses([feedback], [{ cardId: 'f', response: { actionId: 'reply', text: 'Thanks' } }]);
  assert.equal(sending.sending, true);
  assert.equal(sending.pendingAction, undefined);
  assert.equal(withPendingResponses([feedback], [{ cardId: 'f', response: { actionId: 'publish' } }])[0].pendingAction, 'publish');
});

test('opening an update settles it and a link-only update opens its link; approvals and morning cards stay', () => {
  assert.deepEqual(cardOpenPlan(card('u', 'update', { body: 'Digest' })), { target: 'detail', settle: true });
  assert.deepEqual(cardOpenPlan(card('p', 'update', { url: 'scryve-preview://preview/pr-376' })), { target: 'link', settle: true });
  assert.deepEqual(cardOpenPlan(card('a', 'approval', { url: 'https://x.dev' })), { target: 'detail', settle: false });
  assert.deepEqual(cardOpenPlan(card('b', 'briefing')), { target: 'detail', settle: false });
  // Once settled on open, the update leaves the open list and waits in Settled.
  const update = card('p', 'update', { rev: 4 });
  const settled = updateSettledCards(new Map(), [update], 'p', cardOpenPlan(update).settle);
  assert.deepEqual(layout(buildInboxRows({ sessions: [], cards: [update], settledCards: settled, isSnoozed: () => false, collapsed })), ['caughtUp:caught-up', '[Settled 1]']);
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

test('a Hermes approval from a run this phone did not start shows as an approval', () => {
  const approval = card('card:run_9:req_1', 'approval', { source: 'hermes', key: 'run_9:req_1', title: 'Allow git push?', url: 'apollo://session/session_9?agentId=mini&runId=run_9', actions: [{ id: 'approve', label: 'Approve', style: 'primary' }, { id: 'reject', label: 'Reject', style: 'destructive' }] });
  const rows = buildInboxRows({ sessions: [session('session_9'), session('other')], cards: [approval], isSnoozed: () => false, collapsed });
  assert.deepEqual(layout(rows), ['card:card:run_9:req_1', 'session:session_9', 'session:other']);
  assert.deepEqual(hermesApprovalTarget(approval), { sessionId: 'session_9', runId: 'run_9' });
  // The detail screen has the full command, the actions and "Open thread".
  assert.deepEqual(cardOpenPlan(approval), { target: 'detail', settle: false });
  // Resolved elsewhere: it leaves, and does not pile up in Settled.
  assert.deepEqual(layout(buildInboxRows({ sessions: [], cards: [{ ...approval, state: 'resolved' }], isSnoozed: () => false, collapsed })), []);
});

test('a Hermes approval this phone already shows as a waiting thread is hidden behind the thread row', () => {
  const approval = card('card:run_9:req_1', 'approval', { source: 'hermes', key: 'run_9:req_1', url: 'apollo://session/session_9?agentId=mini&runId=run_9' });
  const waiting = [session('session_9', { pendingApproval: true, status: 'attention' })];
  const bySession = buildInboxRows({ sessions: waiting, cards: [approval], runStateLive: true, isSnoozed: () => false, collapsed });
  assert.deepEqual(layout(bySession), ['session:session_9']);
  // Without a url, the run id from the key matches the phone's run state.
  const byRun = buildInboxRows({ sessions: [], cards: [{ ...approval, url: undefined }], pendingRunIds: new Set(['run_9']), runStateLive: true, isSnoozed: () => false, collapsed });
  assert.deepEqual(layout(byRun), []);
});

test('stale run state or a snoozed thread never hides a Hermes approval', () => {
  const approval = card('card:run_9:req_1', 'approval', { source: 'hermes', key: 'run_9:req_1', url: 'apollo://session/session_9?agentId=mini&runId=run_9' });
  const waiting = [session('session_9', { pendingApproval: true, status: 'attention' })];
  // The agent is offline: its remembered runs and threads can't answer Hermes, so the card shows.
  const offline = buildInboxRows({ sessions: waiting, cards: [approval], pendingRunIds: new Set(['run_9']), runStateLive: false, isSnoozed: () => false, collapsed });
  assert.deepEqual(layout(offline), ['card:card:run_9:req_1', 'session:session_9']);
  // Snoozed: the thread isn't on screen, so the card shows.
  const snoozed = buildInboxRows({ sessions: waiting, cards: [approval], runStateLive: true, isSnoozed: () => true, collapsed });
  assert.deepEqual(layout(snoozed), ['card:card:run_9:req_1', '[Snoozed 1]']);
});

test('until live data lands, sections show no count and nothing claims the inbox is empty', () => {
  const input = { sessions: [session('old', { settled: true })], cards: [], isSnoozed: () => false, collapsed };
  const cached = buildInboxRows({ ...input, fresh: false });
  assert.deepEqual(cached.map((row) => row.kind === 'section' ? [row.title, row.count] : row.kind), [['Settled', undefined]]);
  // Live and nothing open: a quiet "All caught up" sits above Settled.
  assert.deepEqual(layout(buildInboxRows(input)), ['caughtUp:caught-up', '[Settled 1]']);
  // Something open, a search or the attention filter: no caught-up row.
  assert.deepEqual(layout(buildInboxRows({ ...input, sessions: [...input.sessions, session('open')] })), ['session:open', '[Settled 1]']);
  assert.deepEqual(layout(buildInboxRows({ ...input, query: 'old' })), ['[Settled 1]', 'session:old']);
  assert.deepEqual(layout(buildInboxRows({ sessions: [], cards: [], isSnoozed: () => false, collapsed })), []);
});

test('only update cards older than three days age into Settled, using their latest activity', () => {
  const now = Date.parse(at(12));
  const date = (age: number) => new Date(now - age * 1000).toISOString();
  const threeDays = 3 * 24 * 60 * 60;
  const old = date(threeDays + 1);
  const cards = [
    card('morning', 'briefing', { createdAt: old, updatedAt: old }),
    card('approval', 'approval', { createdAt: old, updatedAt: old }),
    card('stale', 'update', { createdAt: old, updatedAt: old }),
    card('boundary', 'update', { updatedAt: date(threeDays) }),
    card('reposted', 'update', { createdAt: old, updatedAt: date(60) }),
  ];
  const rows = buildInboxRows({ sessions: [], cards, isSnoozed: () => false, collapsed: { ...collapsed, settled: false } });
  assert.deepEqual(layout(rows), ['briefing:morning', 'card:approval', 'card:reposted', 'card:boundary', '[Settled 1]', 'card:stale']);
  assert.ok(rows.some((row) => row.kind === 'card' && row.id === 'stale' && row.settled));
  assert.equal(cards[2].state, 'open');
});

test('a clock tick ages an update into Settled without new inbox data', () => {
  const updatedAt = at(12);
  const expiry = Date.parse(updatedAt) + 3 * 24 * 60 * 60 * 1000;
  const input = {
    sessions: [],
    cards: [card('aging', 'update', { updatedAt }), card('approval', 'approval', { updatedAt })],
    isSnoozed: () => false,
    collapsed: { ...collapsed, settled: false },
  };
  assert.deepEqual(layout(buildInboxRows({ ...input, now: expiry })), ['card:approval', 'card:aging']);
  const rows = buildInboxRows({ ...input, now: expiry + 60_000 });
  assert.deepEqual(layout(rows), ['card:approval', '[Settled 1]', 'card:aging']);
  assert.ok(rows.some((row) => row.kind === 'card' && row.id === 'aging' && row.settled));
  assert.equal(input.cards[0].state, 'open');
});

test('closed and locally settled response cards stay out of the attention filter', () => {
  const rows = buildInboxRows({
    sessions: [],
    cards: [card('morning', 'briefing', { state: 'settled' }), card('approval', 'approval', { state: 'resolved' }), card('swiped', 'briefing'), card('update', 'update')],
    settledCards: new Map([['swiped', 1]]),
    attentionOnly: true,
    isSnoozed: () => false,
    collapsed,
  });
  assert.deepEqual(layout(rows), []);
});
