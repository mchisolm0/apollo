import assert from 'node:assert/strict';
import test from 'node:test';

import { singleFlight } from './single-flight.ts';

test('calls during a run collapse into one follow-up of the latest task with the latest argument', async () => {
  const seen: string[] = [];
  let finish!: () => void;
  const run = singleFlight<string>();
  const first = run(async () => {
    seen.push('first');
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  const later = (name: string) => async (arg?: string) => { seen.push(`${name}:${arg}`); };
  void run(later('stale'), 'token-a');
  void run(later('stale'));
  void run(later('latest'));
  finish();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, ['first', 'latest:token-a']);
});
