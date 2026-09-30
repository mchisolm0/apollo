import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDuration, liveActivityLabel, readableOutput, settledActivityLabel, toolTarget } from './activity.ts';
import type { TranscriptActivityRow, TranscriptStep } from './transcript.ts';

const activity = (value: Partial<TranscriptActivityRow>): TranscriptActivityRow => ({ id: 'activity', kind: 'activity', status: 'running', phase: 'working', steps: [], ...value });
const running: TranscriptStep = { id: 't1', kind: 'tool', name: 'terminal', input: 'pnpm test', output: '', status: 'running' };

test('a live label names only reported states, in priority order', () => {
  assert.equal(liveActivityLabel(activity({}), 'connected'), 'Working');
  assert.equal(liveActivityLabel(activity({ steps: [running] }), 'connected'), 'Running pnpm test');
  assert.equal(liveActivityLabel(activity({ steps: [{ ...running, name: 'kanban_show', input: '' }] }), 'connected'), 'Kanban Show');
  assert.equal(liveActivityLabel(activity({ phase: 'starting', steps: [running] }), 'connected'), 'Starting');
  assert.equal(liveActivityLabel(activity({ steps: [running] }), 'offline'), 'Reconnecting');
  assert.equal(liveActivityLabel(activity({ steps: [running] }), 'revoked'), 'Access revoked');
  assert.equal(liveActivityLabel(activity({ phase: 'stopping' }), 'offline'), 'Stopping');
  assert.equal(liveActivityLabel(activity({ phase: 'approval' }), 'offline'), 'Needs approval');
});

test('a settled label states the outcome, duration when known, and step count', () => {
  const steps = [{ ...running, status: 'complete' as const }, { id: 'n1', kind: 'note' as const, text: 'Checking.' }];
  assert.equal(settledActivityLabel(activity({ status: 'complete', steps, startedAt: 100, endedAt: 142 })), 'Worked for 42s · 2 steps');
  assert.equal(settledActivityLabel(activity({ status: 'complete', steps: steps.slice(0, 1) })), 'Worked through 1 step');
  assert.equal(settledActivityLabel(activity({ status: 'failed', steps, startedAt: 1_790_000_000_000, endedAt: 1_790_000_030_000 })), 'Failed after 30s · 2 steps');
  assert.equal(settledActivityLabel(activity({ status: 'stopped', startedAt: 100, endedAt: 112 })), 'Stopped after 12s');
  assert.equal(settledActivityLabel(activity({ status: 'complete', steps: [{ id: 'r1', kind: 'thought', text: 'Hmm.' }], startedAt: 100, endedAt: 108 })), 'Thought for 8s');
});

test('formats durations compactly', () => {
  assert.deepEqual([formatDuration(0.4), formatDuration(59.9), formatDuration(192), formatDuration(3_840)], ['0s', '59s', '3m 12s', '1h 4m']);
});

test('unwraps Hermes JSON tool results and leaves other output alone', () => {
  assert.equal(readableOutput('{"output":"No tests found","exit_code":1,"error":null}'), 'No tests found\nExit code 1');
  assert.equal(readableOutput('{"success":false,"error":"File not found"}'), 'File not found');
  assert.equal(readableOutput('{"results":[1,2]}'), '{"results":[1,2]}');
  assert.equal(readableOutput('plain text'), 'plain text');
});

test('reads a durable call target from the argument Hermes previews', () => {
  assert.equal(toolTarget('terminal', { command: 'pnpm   test\n' }), 'pnpm test');
  assert.equal(toolTarget('web_extract', { urls: ['https://a.dev', 'https://b.dev'] }), 'https://a.dev, https://b.dev');
  assert.equal(toolTarget('memory', { action: 'add' }), undefined);
});
