import { createSessionInboxProjector, type SessionInboxState } from './session-inbox.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as inboxModule from './session-inbox.ts';
import type { SessionInboxResult } from './use-session-inbox';

import { AUTO_SETTLE_DELAY_SECONDS, canSettleSession, dateLabel, deriveSessionInbox, isAutoSettleDue, isSessionSnoozed, pruneSnoozedLedger, reopenSession, settleSession, snoozeSession, unsnoozeSession } from './session-inbox.ts';

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

test('expiry prunes the ledger', () => {
  const ledger = snoozeSession(snoozeSession({}, 'a', 50), 'b', 150);
  const pruned = pruneSnoozedLedger(ledger, 100);
  assert.deepEqual(pruned, { b: 150 });
  assert.deepEqual(pruneSnoozedLedger(pruned, 200), {});
});

test('unsnooze returns the thread immediately', () => {
  const ledger = snoozeSession({}, 's', 150);
  assert.equal(isSessionSnoozed(unsnoozeSession(ledger, 's'), 's', 100), false);
  assert.equal(unsnoozeSession(ledger, 'missing'), ledger);
});

test('auto-settle fires only 3h after reading the latest activity', () => {
  const due = { settled: false, running: false, pendingApproval: false, pinned: false, activityAt: 1000, unread: false, failed: false, attention: false };
  const readAt = 2000;
  const at = (seconds: number) => isAutoSettleDue(due, undefined, seconds, readAt);
  assert.equal(at(1000 + AUTO_SETTLE_DELAY_SECONDS + 1), false);
  assert.equal(at(readAt + AUTO_SETTLE_DELAY_SECONDS), false);
  assert.equal(at(readAt + AUTO_SETTLE_DELAY_SECONDS + 1), true);

  const exempt = (overrides: Partial<typeof due>, disabled?: boolean) => isAutoSettleDue({ ...due, ...overrides }, disabled, readAt + AUTO_SETTLE_DELAY_SECONDS + 1, readAt);
  assert.equal(exempt({ settled: true }), false);
  assert.equal(exempt({ running: true }), false);
  assert.equal(exempt({ pendingApproval: true }), false);
  assert.equal(exempt({ pinned: true }), false);
  assert.equal(exempt({ unread: true }), false);
  assert.equal(exempt({ failed: true }), false);
  assert.equal(exempt({ attention: true }), false);
  assert.equal(exempt({}, true), false);
  assert.equal(exempt({}, false), true);
  assert.equal(exempt({}, undefined), true);
  assert.equal(exempt({ activityAt: 0 }), false);
  assert.equal(exempt({ activityAt: readAt + 1 }), false);
  assert.equal(isAutoSettleDue(due, false, readAt + AUTO_SETTLE_DELAY_SECONDS + 1, undefined), false);
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
  assert.equal(isAutoSettleDue(session, false, session.activityAt + AUTO_SETTLE_DELAY_SECONDS + 1, session.activityAt), false);
});

test('auto-settle keeps overnight results, failures, and never-opened threads visible', () => {
  const state: SessionInboxState = {
    sessions: [{ id: 'thread', lastActive: 1000, endedAt: 1000 }],
    runs: {},
    events: [],
  };
  const now = 1000 + AUTO_SETTLE_DELAY_SECONDS + 1;
  const unread = deriveSessionInbox('agent', state)[0];
  assert.equal(isAutoSettleDue(unread, false, now, undefined), false);
  const neverOpened = deriveSessionInbox('agent', { ...state, sessions: [{ id: 'thread', lastActive: 1000 }] })[0];
  assert.equal(isAutoSettleDue(neverOpened, false, now, undefined), false);
  const failed = deriveSessionInbox('agent', { ...state, sessions: [{ ...state.sessions[0], endReason: 'run failed' }] }, {}, { thread: 1000 })[0];
  assert.equal(failed.unread, false);
  assert.equal(isAutoSettleDue(failed, false, now, 1000), false);
});


// Exercise the real hook/store with a clock and hook lifetimes, without native modules.
function inboxFixture() {
  const storage = new Map<string, string>();
  const writes: { agentId: string; settled: Record<string, number> }[] = [];
  const timers = new Map<number, () => void>();
  let now = 100_000;
  let nextTimer = 0;
  let releaseSave: (() => void) | undefined;
  const saving = new Promise<void>((resolve) => { releaseSave = resolve; });
  type Slot = { deps: readonly unknown[]; value?: unknown; cleanup?: () => void };
  let slots: Slot[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps: readonly unknown[]) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
    return slots[index].value;
  };
  const exports = {} as {
    useSessionInbox: (agentId: string, state: SessionInboxState) => SessionInboxResult;
    SessionInboxAutoSettle: (props: { agentId: string; state: SessionInboxState }) => null;
  };
  const source = ts.transpileModule(readFileSync(new URL('./use-session-inbox.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, {
    exports, Date: { now: () => now * 1000 },
    setInterval: (tick: () => void) => { const id = ++nextTimer; timers.set(id, tick); return id; },
    clearInterval: (id: number) => timers.delete(id),
    require: (name: string) => {
      if (name === './session-inbox') return inboxModule;
      if (name === '@/config/posthog') return { posthog: { capture() {} } };
      if (name.endsWith('/outbox-context')) return { useOutbox: () => ({ items: [] }) };
      if (name === '@react-native-async-storage/async-storage') return { __esModule: true, default: {
        getItem: async (key: string) => storage.get(key) ?? null,
        setItem: async (key: string, value: string) => { storage.set(key, value); },
      } };
      if (name === '@/lib') return { useApollo: () => ({ saveInbox: async (agentId: string, settled: Record<string, number>) => { writes.push({ agentId, settled }); await saving; } }) };
      if (name === 'react') return {
        useMemo: memo,
        useCallback: (callback: unknown, deps: readonly unknown[]) => memo(() => callback, deps),
        useRef: (value: unknown) => memo(() => ({ current: value }), []),
        useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
        useEffect: (effect: () => (() => void) | undefined, deps: readonly unknown[]) => {
          const index = cursor++;
          const old = slots[index];
          if (old && same(old.deps, deps)) return;
          const slot: Slot = { deps };
          slots[index] = slot;
          effects.push(() => { old?.cleanup?.(); slot.cleanup = effect(); });
        },
      };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  function mount<T>(component: () => T) {
    const ownSlots: Slot[] = [];
    return {
      render: () => {
        slots = ownSlots;
        cursor = 0;
        effects = [];
        const result = component();
        effects.forEach((effect) => effect());
        return result;
      },
      unmount: () => ownSlots.forEach((slot) => slot.cleanup?.()),
    };
  }
  return { storage, writes, timers, mount, api: exports,
    setNow: (seconds: number) => { now = seconds; },
    tick: () => [...timers.values()].forEach((tick) => tick()),
    releaseSave: () => releaseSave!(),
  };
}

const flushInbox = () => new Promise((resolve) => setImmediate(resolve));

test('reading and rereading use wall time in the compatible local ledger without a read-effect loop', async () => {
  const fixture = inboxFixture();
  const state = { sessions: [{ id: 'thread', lastActive: 20, endedAt: 20 }], runs: {}, events: [] };
  const screen = fixture.mount(() => fixture.api.useSessionInbox('agent', state));
  screen.render();
  await flushInbox();
  const { markRead } = screen.render();
  await markRead('thread');
  const saved = () => JSON.parse(fixture.storage.get('apollo:session-inbox:agent')!);
  assert.deepEqual(saved(), { settled: {}, read: { thread: 100_000 }, snoozed: {}, autoSettleDisabled: {} });
  assert.equal(screen.render().markRead, markRead);
  fixture.setNow(101_000);
  await markRead('thread');
  assert.equal(saved().read.thread, 101_000);
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.writes.length, 0);
});

test('screen mounts do not tick; each agent owner waits after a reread and deduplicates pending settles', async () => {
  const fixture = inboxFixture();
  let state = { sessions: [{ id: 'thread', lastActive: 20, endedAt: 20 }], runs: {}, events: [] };
  const inbox = fixture.mount(() => fixture.api.useSessionInbox('agent', state));
  const thread = fixture.mount(() => fixture.api.useSessionInbox('agent', state));
  const owner = fixture.mount(() => fixture.api.SessionInboxAutoSettle({ agentId: 'agent', state }));
  const otherOwner = fixture.mount(() => fixture.api.SessionInboxAutoSettle({ agentId: 'other', state }));
  inbox.render(); thread.render(); owner.render(); otherOwner.render();
  await flushInbox();
  await thread.render().markRead('thread');
  inbox.render(); owner.render(); otherOwner.render();
  assert.equal(fixture.timers.size, 2);
  fixture.setNow(101_000);
  await thread.render().markRead('thread');
  fixture.setNow(100_000 + AUTO_SETTLE_DELAY_SECONDS + 1);
  fixture.tick();
  assert.equal(fixture.writes.length, 0);
  fixture.setNow(101_000 + AUTO_SETTLE_DELAY_SECONDS);
  fixture.tick();
  assert.equal(fixture.writes.length, 0);
  fixture.setNow(101_000 + AUTO_SETTLE_DELAY_SECONDS + 1);
  fixture.tick();
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0].agentId, 'agent');
  assert.equal(fixture.writes[0].settled.thread, 20);
  state = { ...state };
  owner.render();
  fixture.tick();
  assert.equal(fixture.writes.length, 1);
  owner.unmount(); otherOwner.unmount();
  assert.equal(fixture.timers.size, 0);
  fixture.releaseSave();
  await flushInbox();
});
