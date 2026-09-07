import { createSessionInboxProjector, type SessionInboxState } from './session-inbox.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveSessionInbox, reopenSession, settleSession } from './session-inbox.ts';

const baseState = {
  status: 'connected' as const,
  events: [],
  sessions: [
    { id: 'quiet', title: 'Quiet', startedAt: 10, lastActive: 20 },
    { id: 'new-result', title: 'New result', startedAt: 11, endedAt: 30, lastActive: 30 },
    { id: 'approval', title: 'Approval', startedAt: 12, lastActive: 25 },
  ],
};

test('sorts attention above active and settled sessions', () => {
  const sessions = deriveSessionInbox('agent', {
    ...baseState,
    activeRun: { runId: 'run', sessionId: 'approval', status: 'waiting_for_approval', approval: { command: 'rm tmp' } },
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
    activeRun: { runId: 'run', sessionId: 'session', status: 'completed' },
  });
  const settled = settleSession(session, 20);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.attention, false);
  const revived = deriveSessionInbox('agent', {
    sessions: [{ id: 'session', title: 'Session', startedAt: 10, lastActive: 21 }],
    events: [{ event: 'run.completed', runId: 'next' }],
    activeRun: { runId: 'next', sessionId: 'session', status: 'completed' },
  }, { session: 20 })[0];
  assert.equal(revived.status, 'attention');
});

test('running and pending approval sessions cannot be settled', () => {
  const [session] = deriveSessionInbox('agent', {
    sessions: [{ id: 'session', title: 'Session', startedAt: 10, lastActive: 20 }],
    events: [],
    activeRun: { runId: 'run', sessionId: 'session', status: 'running' },
  });
  assert.equal(settleSession(session, 20), session);

  const [approval] = deriveSessionInbox('agent', {
    sessions: [{ id: 'approval', title: 'Approval', startedAt: 10, lastActive: 20 }],
    events: [],
    activeRun: { runId: 'run', sessionId: 'approval', status: 'waiting_for_approval', approval: { command: 'echo ok' } },
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
    activeRun: { runId: 'other-run', sessionId: 'other', status: 'running' },
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
    activeRun: { runId: 'run', sessionId: 'session', status: 'waiting_for_approval', approval: { command: 'echo ok' } },
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
    activeRun: { runId: 'run', sessionId: 'older-active', status: 'running' },
  });
  assert.deepEqual(sessions.map((session) => session.id), ['newer-active', 'older-active']);
});

test('reopening removes the settled state', () => {
  const [session] = deriveSessionInbox('agent', {
    sessions: [{ id: 'session', title: 'Session', startedAt: 10, lastActive: 20 }],
    events: [{ event: 'run.completed', runId: 'run' }],
    activeRun: { runId: 'run', sessionId: 'session', status: 'completed' },
  }, { session: 20 });
  assert.equal(reopenSession(session).status, 'attention');
});


test('streamed text preserves inbox identity while decisions update the affected row', () => {
  const project = createSessionInboxProjector();
  const state: SessionInboxState = {
    sessions: [{ id: 'running', title: 'Design report' }, { id: 'quiet', title: 'Discord setup' }],
    activeRun: { runId: 'run', sessionId: 'running', status: 'running' },
    events: [],
  };
  const first = project('agent', state, {});
  const streamed = project('agent', { ...state, events: [{ event: 'message.delta', delta: 'More text' }] }, {});
  assert.equal(streamed, first);
  const approval = project('agent', { ...state, activeRun: { ...state.activeRun!, status: 'waiting_for_approval', approval: { command: 'echo test' } } }, {});
  assert.notEqual(approval, first);
  assert.equal(approval.find((item) => item.id === 'quiet'), first.find((item) => item.id === 'quiet'));
  assert.equal(approval[0].pendingApproval, true);
});


test('viewed results become active, new results revive, and approvals still require action', () => {
  const state = { sessions: [{ id: 's', startedAt: 10, endedAt: 20, lastActive: 20 }], events: [] };
  const viewed = deriveSessionInbox('agent', state, {}, { s: 20 })[0];
  assert.equal(viewed.unread, false);
  assert.equal(viewed.status, 'active');
  assert.equal(viewed.settled, false);
  assert.equal(deriveSessionInbox('agent', { ...state, sessions: [{ ...state.sessions[0], lastActive: 21 }] }, {}, { s: 20 })[0].attention, true);
  const approval = deriveSessionInbox('agent', { ...state, activeRun: { runId: 'r', sessionId: 's', status: 'waiting_for_approval', approval: { command: 'echo ok' } } }, {}, { s: 20 })[0];
  assert.equal(approval.pendingApproval, true);
  assert.equal(approval.attention, true);
});

test('read activity excludes events belonging to another run', () => {
  const [session] = deriveSessionInbox('agent', {
    sessions: [{ id: 's', endedAt: 20 }],
    activeRun: { runId: 'current', sessionId: 's', status: 'completed', updatedAt: 20 },
    events: [{ event: 'run.completed', runId: 'other', timestamp: 99 }],
  }, {}, { s: 20 });
  assert.equal(session.activityAt, 20);
  assert.equal(session.attention, false);
});
