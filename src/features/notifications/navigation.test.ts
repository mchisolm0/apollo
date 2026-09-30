import test from 'node:test';
import assert from 'node:assert/strict';

import { notificationDestination } from './navigation.ts';

test('notification navigation accepts only complete local run destinations', () => {
  assert.deepEqual(notificationDestination({ kind: 'approval', agent_id: 'agent_1', session_id: 'session_1', run_id: 'run_1' }), {
    pathname: '/session/[id]', params: { id: 'session_1', agentId: 'agent_1', runId: 'run_1' },
  });
  assert.equal(notificationDestination({ kind: 'approval', agent_id: '../agent', session_id: 'session_1', run_id: 'run_1' }), undefined);
  assert.equal(notificationDestination({ kind: 'completed', agent_id: 'agent_1', session_id: 'https://example.com', run_id: 'run_1' }), undefined);
  assert.equal(notificationDestination({ kind: 'unknown', agent_id: 'agent_1', session_id: 'session_1', run_id: 'run_1' }), undefined);
});
