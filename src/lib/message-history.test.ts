import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileHistory } from './message-history.ts';
import type { HermesMessage } from './types.ts';

test('a delayed history snapshot cannot erase an accepted message, including repeated prompts', () => {
  const old: HermesMessage = { id: 'u1', role: 'user', content: 'Continue' };
  const pending: HermesMessage = { id: 'run-user-r2', role: 'user', content: 'Continue' };
  assert.deepEqual(reconcileHistory([pending], []), [pending]);
  assert.deepEqual(reconcileHistory([old, pending], [old]), [old, pending]);
  const saved: HermesMessage = { ...pending, id: 'u2' };
  assert.deepEqual(reconcileHistory([old, pending], [old, saved]), [old, saved]);
  assert.deepEqual(reconcileHistory([old, saved], [old]), [old, saved]);
});
