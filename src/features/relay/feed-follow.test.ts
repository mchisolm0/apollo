import assert from 'node:assert/strict';
import test from 'node:test';
import { followAfterScroll } from './feed-follow.ts';

test('streaming and disclosure layout changes never resume a paused reader', () => {
  let following = followAfterScroll(true, 'begin', true);
  assert.equal(following, false);
  following = followAfterScroll(following, 'layout', true);
  assert.equal(following, false);
  assert.equal(followAfterScroll(following, 'end', false), false);
  assert.equal(followAfterScroll(following, 'end', true), true);
  assert.equal(followAfterScroll(false, 'jump', false), true);
});
