import assert from 'node:assert/strict';
import test from 'node:test';

import { countsReady, displayConnection } from './connection-state.ts';

test('a missing or idle agent reads as connecting during the launch grace, then offline', () => {
  for (const status of [undefined, 'idle'] as const) {
    assert.equal(displayConnection(status, false), 'connecting');
    assert.equal(displayConnection(status, true), 'offline');
  }
  for (const status of ['connected', 'connecting', 'offline', 'revoked'] as const) {
    assert.equal(displayConnection(status, false), status);
    assert.equal(displayConnection(status, true), status);
  }
});

test('counts wait for live sessions and cards, but never past the launch grace', () => {
  const base = { sessionsLoaded: true, cardsLoaded: true, cloudOff: false, graceOver: false };
  assert.equal(countsReady(base), true);
  assert.equal(countsReady({ ...base, sessionsLoaded: false }), false);
  assert.equal(countsReady({ ...base, cardsLoaded: false }), false);
  assert.equal(countsReady({ ...base, cardsLoaded: false, cloudOff: true }), true);
  // A failed refresh or snapshot can't hide counts once the grace is over.
  assert.equal(countsReady({ sessionsLoaded: false, cardsLoaded: false, cloudOff: false, graceOver: true }), true);
});
