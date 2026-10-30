import assert from 'node:assert/strict';
import test from 'node:test';
import { STREAM_TICK_MS, streamTick, type StreamTickState } from './stream-tick.ts';

test('a reply already streaming when the thread opens stays quiet', () => {
  assert.equal(streamTick(undefined, { id: 'a', length: 40 }, 1000).tick, false);
});

test('a new reply ticks at once, then growth ticks no faster than the throttle', () => {
  let state: StreamTickState | undefined = null;
  const ticks: number[] = [];
  for (const [now, length] of [[1000, 1], [1100, 5], [1200, 9], [1000 + STREAM_TICK_MS, 12], [1400, 15], [1400, 15], [2000, 15]] as const) {
    const next = streamTick(state, { id: 'a', length }, now);
    state = next.state;
    if (next.tick) ticks.push(now);
  }
  assert.deepEqual(ticks, [1000, 1000 + STREAM_TICK_MS]);
});

test('the next reply ticks even inside the throttle window', () => {
  const first = streamTick(null, { id: 'a', length: 1 }, 1000);
  assert.equal(streamTick(first.state, { id: 'b', length: 1 }, 1010).tick, true);
});

test('a finished reply resets so the next one ticks', () => {
  const ended = streamTick({ id: 'a', length: 10, tickedAt: 1000 }, undefined, 1100);
  assert.equal(ended.state, null);
  assert.equal(streamTick(ended.state, { id: 'b', length: 1 }, 1110).tick, true);
});
