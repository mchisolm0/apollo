import assert from 'node:assert/strict';
import test from 'node:test';
import { feedFollowOptions, followAfterScroll } from './feed-follow.ts';

test('streaming and disclosure layout changes never resume a paused reader', () => {
  let following = followAfterScroll(true, 'begin', true);
  assert.equal(following, false);
  following = followAfterScroll(following, 'layout', true);
  assert.equal(following, false);
  assert.equal(followAfterScroll(following, 'end', false), false);
  assert.equal(followAfterScroll(following, 'end', true), true);
  assert.equal(followAfterScroll(false, 'jump', false), true);
});

test('follows the final viewport after a large composer or keyboard changes its height', () => {
  const options = feedFollowOptions(true);
  assert.ok(options);
  assert.equal(options.on.layout, true);
  assert.equal(options.on.dataChange, true);
  assert.equal(options.on.itemLayout, true);
  const paused = followAfterScroll(true, 'begin', true);
  assert.equal(feedFollowOptions(followAfterScroll(paused, 'layout', true)), false);
  assert.ok(feedFollowOptions(followAfterScroll(paused, 'jump', false)));
});
