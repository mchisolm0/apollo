import test from 'node:test';
import assert from 'node:assert/strict';

import { foregroundNotificationBehavior, setVisibleNotificationSession } from './foreground.ts';

const data = { kind: 'completed', agent_id: 'agent_1', session_id: 'session_1', run_id: 'run_1' };
const show = { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
const suppress = { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };

test('only run notifications for the visible agent and session stay silent', () => {
  const session = { agentId: 'agent_1', sessionId: 'session_1' };
  for (const kind of ['approval', 'completed', 'failed']) {
    assert.deepEqual(foregroundNotificationBehavior({ ...data, kind }, session), suppress);
  }
  assert.deepEqual(foregroundNotificationBehavior({ ...data, session_id: 'session_2' }, session), show);
  assert.deepEqual(foregroundNotificationBehavior({ ...data, agent_id: 'agent_2' }, session), show);
  for (const invalid of [undefined, null, [], {}, { session_id: 'session_1' }, { ...data, kind: 'unknown' }]) {
    assert.deepEqual(foregroundNotificationBehavior(invalid, session), show);
  }
  assert.deepEqual(foregroundNotificationBehavior(data), show);
  assert.deepEqual(foregroundNotificationBehavior({ cardId: 'card_1', source: 'fleet', kind: 'update' }, session), { ...suppress, shouldShowList: true });
  assert.deepEqual(foregroundNotificationBehavior({ cardId: 'card_2', source: 'preview', kind: 'approval' }, session), show);
});

test('focus changes are immediate and stale blur cleanup preserves the current thread', () => {
  const blurFirst = setVisibleNotificationSession('agent_1', 'session_1');
  try {
    assert.deepEqual(foregroundNotificationBehavior(data), suppress);
    const blurSecond = setVisibleNotificationSession('agent_1', 'session_2');
    try {
      blurFirst();
      assert.deepEqual(foregroundNotificationBehavior(data), show);
      assert.deepEqual(foregroundNotificationBehavior({ ...data, session_id: 'session_2' }), suppress);
    } finally { blurSecond(); }
    assert.deepEqual(foregroundNotificationBehavior({ ...data, session_id: 'session_2' }), show);
  } finally { blurFirst(); }
});
