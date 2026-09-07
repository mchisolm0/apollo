import assert from 'node:assert/strict';
import test from 'node:test';
import { currentApproval, isRunActive, statusAfterEvent } from './run-state.ts';

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
