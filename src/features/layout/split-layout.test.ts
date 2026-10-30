import test from 'node:test';
import assert from 'node:assert/strict';

import { sidebarOpenAction, sidebarWidth } from './split-layout.ts';

test('iPhones stay single-pane in both orientations', () => {
  assert.equal(sidebarWidth({ width: 440, height: 956 }), undefined);
  assert.equal(sidebarWidth({ width: 956, height: 440 }), undefined);
});

test('iPad mini splits in both orientations and the sidebar width is clamped', () => {
  assert.equal(sidebarWidth({ width: 744, height: 1133 }), 280);
  assert.equal(sidebarWidth({ width: 1133, height: 744 }), 363);
  assert.equal(sidebarWidth({ width: 1376, height: 1032 }), 380);
});

test('a resized window crosses the breakpoint at 720 by 600', () => {
  assert.equal(sidebarWidth({ width: 719, height: 900 }), undefined);
  assert.equal(sidebarWidth({ width: 720, height: 599 }), undefined);
  assert.equal(sidebarWidth({ width: 720, height: 600 }), 280);
});

test('a sidebar pick replaces an open thread and pushes over the empty pane', () => {
  assert.equal(sidebarOpenAction('/session/s_1'), 'replace');
  assert.equal(sidebarOpenAction('/session/new'), 'replace');
  assert.equal(sidebarOpenAction('/'), 'push');
});
