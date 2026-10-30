import test from 'node:test';
import assert from 'node:assert/strict';

import { activeThread, buildShortcutActions, MAX_RECENT_THREADS, NEW_THREAD_SHORTCUT_ID, parseRecentThreads, shortcutDestination, withRecentThread, type RecentThread } from './app-shortcuts.ts';

const thread = (suffix: string, title = `Thread ${suffix}`, agentId = 'agent_a'): RecentThread => ({ agentId, sessionId: `s_${suffix}`, title });
const icon = (kind: 'new' | 'thread') => kind;

test('recent threads move to the front, cap at the shortcut budget, and keep known titles', () => {
  assert.deepEqual(withRecentThread([thread('a'), thread('b')], thread('b')).map((entry) => entry.sessionId), ['s_b', 's_a']);
  const capped = withRecentThread([thread('a'), thread('b'), thread('c')], thread('d'));
  assert.equal(capped.length, MAX_RECENT_THREADS);
  assert.deepEqual(capped.map((entry) => entry.sessionId), ['s_d', 's_a', 's_b']);
  const current = [thread('a', 'Fix the build')];
  assert.equal(withRecentThread(current, thread('a', '')), current);
  assert.equal(withRecentThread([thread('a', '')], thread('a', 'Named'))[0]?.title, 'Named');
  assert.equal(withRecentThread([thread('a', 'x', 'agent_a')], thread('a', 'x', 'agent_b')).length, 2);
});

test('shortcut actions lead with New thread and fall back to a generic label', () => {
  const actions = buildShortcutActions([thread('a', '  ')], icon);
  assert.equal(actions[0]?.id, NEW_THREAD_SHORTCUT_ID);
  assert.deepEqual(actions[0]?.params, { kind: 'new' });
  assert.equal(actions[1]?.title, 'Thread');
  assert.deepEqual(actions[1]?.params, { kind: 'thread', agentId: 'agent_a', sessionId: 's_a' });
  const [, first] = buildShortcutActions([{ agentId: 'a-b', sessionId: 'c', title: '' }], icon);
  const [, second] = buildShortcutActions([{ agentId: 'a', sessionId: 'b-c', title: '' }], icon);
  assert.notEqual(first?.id, second?.id);
});

test('shortcut destinations accept only shapes the app built, for paired agents', () => {
  const agents = ['agent_a', 'agent_b'];
  const open = (params: Record<string, unknown> | undefined) => shortcutDestination({ id: 'x', title: 'x', params: params as Record<string, string> }, agents, [thread('a', 'x', 'agent_b')]);
  assert.deepEqual(open({ kind: 'thread', agentId: 'agent_a', sessionId: 's_1' }), { pathname: '/session/[id]', params: { id: 's_1', agentId: 'agent_a' } });
  assert.deepEqual(open({ kind: 'new' }), { pathname: '/session/[id]', params: { id: 'new', agentId: 'agent_b' } });
  assert.deepEqual(shortcutDestination({ id: 'x', title: 'x', params: { kind: 'new' } }, agents, [thread('a', 'x', 'gone')]), { pathname: '/session/[id]', params: { id: 'new', agentId: 'agent_a' } });
  assert.deepEqual(shortcutDestination({ id: 'x', title: 'x', params: { kind: 'new' } }, [], []), { pathname: '/' });
  for (const params of [
    undefined,
    {},
    { kind: 'thread', agentId: 'gone', sessionId: 's_1' },
    { kind: 'thread', agentId: 'agent_a', sessionId: '../s' },
    { kind: 'thread', agentId: 'agent_a', sessionId: 'https://evil.example' },
    { kind: 'thread', agentId: 'agent_a', sessionId: 'new' },
    { kind: 'thread', agentId: 'agent_a', sessionId: 3 },
    { kind: 'thread', agentId: 'agent_a' },
    { href: '/session/s_1' },
  ]) assert.equal(open(params), undefined);
});

test('active thread reads only session routes with valid ids', () => {
  assert.deepEqual(activeThread('/session/s_1', { id: 's_1', agentId: 'agent_a' }), { agentId: 'agent_a', sessionId: 's_1' });
  assert.deepEqual(activeThread('/session/s_1', { id: ['s_1'], agentId: ['agent_a'] }), { agentId: 'agent_a', sessionId: 's_1' });
  assert.equal(activeThread('/session/new', { id: 'new', agentId: 'agent_a' }), undefined);
  assert.equal(activeThread('/settings/agent_a', { agentId: 'agent_a' }), undefined);
  assert.equal(activeThread('/session/x', { id: ' ', agentId: 'agent_a' }), undefined);
});

test('stored recents drop malformed entries and survive corrupt storage', () => {
  assert.deepEqual(parseRecentThreads(JSON.stringify([thread('a'), { agentId: 'agent_a' }, null, { agentId: 'agent_a', sessionId: 's_b', title: 4 }])), [thread('a'), { agentId: 'agent_a', sessionId: 's_b', title: '' }]);
  assert.deepEqual(parseRecentThreads('{'), []);
  assert.deepEqual(parseRecentThreads('{"a":1}'), []);
  assert.deepEqual(parseRecentThreads(null), []);
});
