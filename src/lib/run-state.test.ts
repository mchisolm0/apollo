import assert from 'node:assert/strict';
import test from 'node:test';
import { currentApproval, isRunActive, openApprovals, statusAfterEvent } from './run-state.ts';

test('a lost run does not keep streaming or show a stale approval', () => {
  const run = { runId: 'lost', status: 'unknown', approval: { command: 'pwd' } } as const;
  assert.equal(isRunActive(run.status), false);
  assert.equal(currentApproval([{ event: 'approval.request', command: 'pwd' }], run), undefined);
});

test('approval events override stale status and terminal events end attention', () => {
  const waiting = { runId: 'run-1', status: 'waiting_for_approval', approval: { command: 'pwd' } } as const;
  assert.equal(currentApproval([], waiting)?.command, 'pwd');
  assert.equal(currentApproval([{ event: 'approval.responded' }], waiting), undefined);
  const finished = statusAfterEvent(waiting, { event: 'run.completed', timestamp: 10 });
  assert.equal(isRunActive(finished.status), false);
  assert.equal(finished.approval, undefined);
  assert.equal(currentApproval([{ event: 'approval.request', command: 'pwd' }, { event: 'run.completed' }], waiting), undefined);
});

test('interruption clears a pending decision and ends the active run', () => {
  const run = { runId: 'run-1', status: 'waiting_for_approval', approval: { command: 'pwd' } } as const;
  const event = { event: 'run.interrupted' };
  assert.equal(statusAfterEvent(run, event).status, 'interrupted');
  assert.equal(currentApproval([event], run), undefined);
});

test('two requests at once: the older one shows once the newer is answered, until its time runs out', () => {
  const run = { runId: 'run-1', status: 'running' } as const;
  const older = { event: 'approval.request', request_id: 'a', command: 'ls', timestamp: 100 };
  const newer = { event: 'approval.request', request_id: 'b', command: 'pwd', timestamp: 101 };
  assert.equal(currentApproval([older, newer], run)?.command, 'ls');
  assert.equal(currentApproval([older, newer, { event: 'approval.responded', request_id: 'a' }], run)?.command, 'pwd');
  const answeredNewer = [older, newer, { event: 'approval.responded', request_id: 'b' }];
  assert.equal(currentApproval(answeredNewer, run)?.command, 'ls');
  assert.equal(currentApproval(answeredNewer, run, { timeoutSeconds: 300, now: 399 })?.command, 'ls');
  assert.equal(currentApproval(answeredNewer, run, { timeoutSeconds: 300, now: 400 }), undefined);
  // An answer without a request id settles the oldest, as Hermes does.
  assert.equal(currentApproval([older, newer, { event: 'approval.responded' }], run)?.command, 'pwd');
});

test('a request expires at its own captured timeout, and an answer without an id skips expired ones', () => {
  const run = { runId: 'run-1', status: 'running' } as const;
  const older = { event: 'approval.request', request_id: 'a', command: 'ls', timestamp: 100, timeout_s: 60 };
  const newer = { event: 'approval.request', request_id: 'b', command: 'pwd', timestamp: 101, timeout_s: 600 };
  // The config changed to 30s after both asked; each keeps the timeout Hermes captured.
  assert.equal(currentApproval([older, newer], run, { timeoutSeconds: 30, now: 150 })?.command, 'ls');
  assert.equal(currentApproval([older, newer], run, { timeoutSeconds: 30, now: 160 })?.command, 'pwd');
  // a timed out at 160; an id-less answer at 170 settled b, the oldest still waiting.
  assert.equal(currentApproval([older, newer, { event: 'approval.responded', timestamp: 170 }], run, { now: 170 }), undefined);
  assert.deepEqual(openApprovals([older, newer, { event: 'approval.responded', timestamp: 170 }]).map((ask) => ask.request_id), ['a']);
  // A local answer and the stream's answer for the same request close only that one.
  const twice = [older, newer, { event: 'approval.responded', request_id: 'a' }, { event: 'approval.responded', request_id: 'a' }];
  assert.deepEqual(openApprovals(twice).map((ask) => ask.request_id), ['b']);
});
