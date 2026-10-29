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

test('a long thread accepts its latest page once a local send is saved, though older turns paged out', () => {
  const saved = (sequence: number, role: string): HermesMessage => ({ id: `m${sequence}`, sequence, role, content: role });
  const pending: HermesMessage = { id: 'run-user-r3', role: 'user', content: 'Next' };
  const current = [saved(1, 'user'), saved(2, 'assistant'), saved(3, 'user'), saved(4, 'assistant'), pending];
  // Hermes returns only the newest page, so turn 1 has left it.
  assert.deepEqual(reconcileHistory(current, [saved(3, 'user'), saved(4, 'assistant')]), current);
  const page = [saved(3, 'user'), saved(4, 'assistant'), saved(5, 'user'), saved(6, 'assistant')];
  assert.deepEqual(reconcileHistory(current, page), page);
  // A delayed page cannot erase a saved user message either.
  assert.deepEqual(reconcileHistory(page, current.slice(0, 4)), page);
  assert.deepEqual(reconcileHistory(page, []), page);
});
