import { createSessionInboxProjector, type SessionInboxState } from './session-inbox.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTO_SETTLE_DELAY_SECONDS, countSnoozedSessions, canSettleSession, dateLabel, deriveSessionInbox, isAutoSettleDue, isSessionSnoozed, pruneSnoozedLedger, reopenSession, settleSession, snoozeSession, unsnoozeSession } from './session-inbox.ts';

const baseState = {
  status: 'connected' as const,
  events: [],
  runs: {},
  sessions: [
    { id: 'quiet', title: 'Quiet', startedAt: 10, lastActive: 20 },
    { id: 'new-result', title: 'New result', startedAt: 11, endedAt: 30, lastActive: 30 },
    { id: 'approval', title: 'Approval', startedAt: 12, lastActive: 25 },
  ],
};

test('sorts attention above active and settled sessions', () => {
  const sessions = deriveSessionInbox('agent', {
    ...baseState,
    runs: { run: { runId: 'run', sessionId: 'approval', status: 'waiting_for_approval', approval: { command: 'rm tmp' } } },
  });
  assert.deepEqual(sessions.map((session) => [session.id, session.status]), [
    ['new-result', 'attention'],
    ['approval', 'attention'],
    ['quiet', 'active'],
  ]);
});

test('old idle sessions are active until explicitly settled, without pretending to run', () => {
  const [session] = deriveSessionInbox('agent', {
    sessions: [{ id: 'old', title: 'Old', startedAt: 10, lastActive: 20 }],
    events: [],
    runs: {},
  });
  assert.equal(session.status, 'active');
  assert.equal(session.running, false);
  const settled = settleSession(session, 20);
  assert.equal(settled.status, 'settled');
});

test('settling a completed result revives when activity advances', () => {
  const [session] = deriveSessionInbox('agent', {
    sessions: [{ id: 'session', title: 'Session', startedAt: 10, lastActive: 20 }],
    events: [{ event: 'run.completed', runId: 'run' }],
    runs: { run: { runId: 'run', sessionId: 'session', status: 'completed' } },
  });
  const settled = settleSession(session, 20);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.attention, false);
  const revived = deriveSessionInbox('agent', {
    sessions: [{ id: 'session', title: 'Session', startedAt: 10, lastActive: 21 }],
    events: [{ event: 'run.completed', runId: 'next' }],
    runs: { run: { runId: 'next', sessionId: 'session', status: 'completed' } },
  }, { session: 20 })[0];
  assert.equal(revived.status, 'attention');
});

test('running and pending approval sessions cannot be settled', () => {
  const [session] = deriveSessionInbox('agent', {
    sessions: [{ id: 'session', title: 'Session', startedAt: 10, lastActive: 20 }],
    events: [],
    runs: { run: { runId: 'run', sessionId: 'session', status: 'running' } },
  });
  assert.equal(settleSession(session, 20), session);

  const [approval] = deriveSessionInbox('agent', {
    sessions: [{ id: 'approval', title: 'Approval', startedAt: 10, lastActive: 20 }],
    events: [],
    runs: { run: { runId: 'run', sessionId: 'approval', status: 'waiting_for_approval', approval: { command: 'echo ok' } } },
  });
  assert.equal(settleSession(approval, 20), approval);
});

test('a newer session activity revives while another session is running', () => {
  const revived = deriveSessionInbox('agent', {
    sessions: [
      { id: 'settled', title: 'Settled', startedAt: 10, lastActive: 22 },
      { id: 'other', title: 'Other', startedAt: 11, lastActive: 30 },
    ],
    events: [],
    runs: { run: { runId: 'other-run', sessionId: 'other', status: 'running' } },
  }, { settled: 20 }).find((session) => session.id === 'settled');
  assert.equal(revived?.status, 'active');
  assert.equal(revived?.running, false);
});

test('terminal approval events override a stale waiting status', () => {
  const [session] = deriveSessionInbox('agent', {
    sessions: [{ id: 'session', title: 'Session', startedAt: 10, lastActive: 20 }],
    events: [
      { event: 'approval.request', runId: 'run', timestamp: 20, command: 'echo ok' },
      { event: 'approval.responded', runId: 'run', timestamp: 21 },
      { event: 'run.completed', runId: 'run', timestamp: 22 },
    ],
    runs: { run: { runId: 'run', sessionId: 'session', status: 'waiting_for_approval', approval: { command: 'echo ok' } } },
  });
  assert.equal(session.pendingApproval, false);
  assert.equal(session.status, 'attention');
});

test('active sessions sort by creation time while attention uses activity time', () => {
  const sessions = deriveSessionInbox('agent', {
    sessions: [
      { id: 'older-active', title: 'Older', startedAt: 10, lastActive: 100 },
      { id: 'newer-active', title: 'Newer', startedAt: 20, lastActive: 1 },
    ],
    events: [],
    runs: { run: { runId: 'run', sessionId: 'older-active', status: 'running' } },
  });
  assert.deepEqual(sessions.map((session) => session.id), ['newer-active', 'older-active']);
});

test('reopening removes the settled state', () => {
  const [session] = deriveSessionInbox('agent', {
    sessions: [{ id: 'session', title: 'Session', startedAt: 10, lastActive: 20 }],
    events: [{ event: 'run.completed', runId: 'run' }],
    runs: { run: { runId: 'run', sessionId: 'session', status: 'completed' } },
  }, { session: 20 });
  assert.equal(reopenSession(session).status, 'attention');
});


test('streamed text preserves inbox identity while decisions update the affected row', () => {
  const project = createSessionInboxProjector();
  const state: SessionInboxState = {
    sessions: [{ id: 'running', title: 'Design report' }, { id: 'quiet', title: 'Discord setup' }],
    runs: { run: { runId: 'run', sessionId: 'running', status: 'running' } },
    events: [],
  };
  const first = project('agent', state, {});
  const streamed = project('agent', { ...state, events: [{ event: 'message.delta', delta: 'More text' }] }, {});
  assert.equal(streamed, first);
  const approval = project('agent', { ...state, runs: { run: { ...state.runs.run, status: 'waiting_for_approval', approval: { command: 'echo test' } } } }, {});
  assert.notEqual(approval, first);
  assert.equal(approval.find((item) => item.id === 'quiet'), first.find((item) => item.id === 'quiet'));
  assert.equal(approval[0].pendingApproval, true);
});


test('viewed results become active, new results revive, and approvals still require action', () => {
  const state = { runs: {}, sessions: [{ id: 's', startedAt: 10, endedAt: 20, lastActive: 20 }], events: [] };
  const viewed = deriveSessionInbox('agent', state, {}, { s: 20 })[0];
  assert.equal(viewed.unread, false);
  assert.equal(viewed.status, 'active');
  assert.equal(viewed.settled, false);
  assert.equal(deriveSessionInbox('agent', { ...state, sessions: [{ ...state.sessions[0], lastActive: 21 }] }, {}, { s: 20 })[0].attention, true);
  const approval = deriveSessionInbox('agent', { ...state, runs: { run: { runId: 'r', sessionId: 's', status: 'waiting_for_approval', approval: { command: 'echo ok' } } } }, {}, { s: 20 })[0];
  assert.equal(approval.pendingApproval, true);
  assert.equal(approval.attention, true);
});

test('read activity excludes events belonging to another run', () => {
  const [session] = deriveSessionInbox('agent', {
    sessions: [{ id: 's', endedAt: 20 }],
    runs: { run: { runId: 'current', sessionId: 's', status: 'completed', updatedAt: 20 } },
    events: [{ event: 'run.completed', runId: 'other', timestamp: 99 }],
  }, {}, { s: 20 });
  assert.equal(session.activityAt, 20);
  assert.equal(session.attention, false);
});


test('a new device uses server settle state and new activity reopens the thread', () => {
  const state = { runs: {}, events: [], sessions: [{ id: 'thread', lastActive: 20, settledAt: 20 }] };
  assert.equal(deriveSessionInbox('agent', state)[0].settled, true);
  assert.equal(deriveSessionInbox('agent', { ...state, sessions: [{ ...state.sessions[0], lastActive: 21 }] })[0].settled, false);
  assert.equal(deriveSessionInbox('agent', { ...state, sessions: [{ ...state.sessions[0], settledAt: null }] }, { thread: 20 })[0].settled, false);
});

test('concurrent threads show their own running and approval state', () => {
  const sessions = deriveSessionInbox('agent', {
    sessions: [{ id: 'first' }, { id: 'second' }],
    runs: {
      first: { runId: 'first', sessionId: 'first', status: 'running' },
      second: { runId: 'second', sessionId: 'second', status: 'waiting_for_approval' },
    },
    events: [{ event: 'approval.request', runId: 'second', command: 'echo second' }],
  });
  assert.equal(sessions.find((session) => session.id === 'first')?.running, true);
  assert.equal(sessions.find((session) => session.id === 'first')?.pendingApproval, false);
  assert.equal(sessions.find((session) => session.id === 'second')?.pendingApproval, true);
});

test('failed runs stay explicit on the row', () => {
  const [session] = deriveSessionInbox('agent', {
    sessions: [{ id: 'session', title: 'Session', startedAt: 10, lastActive: 20, endReason: 'run failed' }],
    events: [],
    runs: {},
  });
  assert.equal(session.failed, true);
});

test('run.error events and error flags mark the row failed', () => {
  const [viaEvent] = deriveSessionInbox('agent', {
    sessions: [{ id: 'session', title: 'Session', startedAt: 10, lastActive: 20 }],
    events: [{ event: 'run.error', runId: 'run', error: true }],
    runs: { run: { runId: 'run', sessionId: 'session', status: 'running' } },
  });
  assert.equal(viaEvent.failed, true);

  const [viaStatus] = deriveSessionInbox('agent', {
    sessions: [{ id: 'session', title: 'Session', startedAt: 10, lastActive: 20 }],
    events: [],
    runs: { run: { runId: 'run', sessionId: 'session', status: 'running', error: 'boom' } },
  });
  assert.equal(viaStatus.failed, true);
});

test('snoozed threads stay hidden until the snooze expires', () => {
  const ledger = snoozeSession({}, 's', 100);
  assert.equal(isSessionSnoozed(ledger, 's', 99), true);
  assert.equal(isSessionSnoozed(ledger, 's', 100), false);
  assert.equal(isSessionSnoozed(ledger, 's', 101), false);
  assert.equal(isSessionSnoozed(ledger, 'other', 99), false);
});

test('expiry prunes the ledger and counts drop back to zero', () => {
  const ledger = snoozeSession(snoozeSession({}, 'a', 50), 'b', 150);
  const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(countSnoozedSessions(sessions, ledger, 40), 2);
  assert.equal(countSnoozedSessions(sessions, ledger, 100), 1);
  const pruned = pruneSnoozedLedger(ledger, 100);
  assert.deepEqual(pruned, { b: 150 });
  assert.equal(countSnoozedSessions(sessions, pruned, 200), 0);
});

test('unsnooze returns the thread immediately', () => {
  const ledger = snoozeSession({}, 's', 150);
  assert.equal(isSessionSnoozed(unsnoozeSession(ledger, 's'), 's', 100), false);
  assert.equal(unsnoozeSession(ledger, 'missing'), ledger);
});

test('auto-settle fires only 3h after activity on settle-eligible threads', () => {
  const due = { settled: false, running: false, pendingApproval: false, pinned: false, activityAt: 1000 };
  const at = (seconds: number) => isAutoSettleDue(due, undefined, seconds);
  assert.equal(at(1000 + AUTO_SETTLE_DELAY_SECONDS), false);
  assert.equal(at(1000 + AUTO_SETTLE_DELAY_SECONDS + 1), true);

  const exempt = (overrides: Partial<typeof due>, disabled?: boolean) => isAutoSettleDue({ ...due, ...overrides }, disabled, 1000 + AUTO_SETTLE_DELAY_SECONDS + 1);
  assert.equal(exempt({ settled: true }), false);
  assert.equal(exempt({ running: true }), false);
  assert.equal(exempt({ pendingApproval: true }), false);
  assert.equal(exempt({ pinned: true }), false);
  assert.equal(exempt({}, true), false);
  assert.equal(exempt({}, false), true);
  assert.equal(exempt({}, undefined), true);
  assert.equal(isAutoSettleDue({ ...due, activityAt: 0 }, undefined, 1000 + AUTO_SETTLE_DELAY_SECONDS + 1), false);
});

test('inbox ages are compact for the last week', () => {
  const now = 1_790_000_000_000;
  const ago = (seconds: number) => now / 1000 - seconds;
  assert.equal(dateLabel(ago(30), now), 'now');
  assert.equal(dateLabel(ago(14 * 60), now), '14m');
  assert.equal(dateLabel(ago(8 * 3600), now), '8h');
  assert.equal(dateLabel(ago(3 * 86400), now), '3d');
  assert.doesNotMatch(dateLabel(ago(10 * 86400), now), /^\d+[mhd]$/u);
  assert.equal(dateLabel(0, now), '');
});


test('queued messages prevent manual and automatic settling', () => {
  const session = { ...deriveSessionInbox('agent', baseState).find((item) => item.id === 'quiet')!, queued: true };
  assert.equal(canSettleSession(session), false);
  assert.equal(isAutoSettleDue(session, false, session.activityAt + AUTO_SETTLE_DELAY_SECONDS + 1), false);
});
