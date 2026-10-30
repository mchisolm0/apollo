import assert from 'node:assert/strict';
import test from 'node:test';

import { customSnoozeUntil, resolveSnoozePresets } from './snooze-presets.ts';

const ids = (now: Date) => resolveSnoozePresets(now).map((preset) => preset.id);

test('a weekday morning offers every preset', () => {
  // Wednesday 10:00 local.
  const now = new Date(2026, 9, 28, 10, 0);
  assert.deepEqual(ids(now), ['hour', 'three-hours', 'evening', 'tomorrow', 'next-week']);
  const [hour, , evening, tomorrow, nextWeek] = resolveSnoozePresets(now);
  assert.equal(hour.until, Math.floor(now.getTime() / 1000) + 3600);
  assert.equal(evening.until, new Date(2026, 9, 28, 18).getTime() / 1000);
  assert.equal(tomorrow.until, new Date(2026, 9, 29, 9).getTime() / 1000);
  assert.equal(nextWeek.until, new Date(2026, 10, 2, 9).getTime() / 1000);
});

test('evening drops once it is less than an hour away', () => {
  assert.ok(!ids(new Date(2026, 9, 28, 17, 30)).includes('evening'));
});

test('on Sunday next week collapses into tomorrow', () => {
  assert.ok(!ids(new Date(2026, 10, 1, 10, 0)).includes('next-week'));
});

test('on Monday next week is the following Monday', () => {
  const nextWeek = resolveSnoozePresets(new Date(2026, 10, 2, 10, 0)).find((preset) => preset.id === 'next-week');
  assert.equal(nextWeek?.until, new Date(2026, 10, 9, 9).getTime() / 1000);
});

test('custom snoozes must be in the future', () => {
  const now = new Date(2026, 9, 28, 10, 0);
  assert.equal(customSnoozeUntil(new Date(2026, 9, 28, 9, 0), now), undefined);
  assert.equal(customSnoozeUntil(new Date(Number.NaN), now), undefined);
  assert.equal(customSnoozeUntil(new Date(2026, 9, 28, 11, 0), now), new Date(2026, 9, 28, 11).getTime() / 1000);
});
