import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyTheme, parseTheme, THEMES, THEME_STORAGE_KEY } from './theme.ts';

const base = {
  background: '#000000',
  surface: '#1c1c1e',
  elevated: '#222224',
  line: '#292929',
  lineStrong: '#38383a',
  primary: '#ffffff',
  secondary: '#aaaaaa',
  muted: '#929298',
  cyan: '#a7c8ff',
  amber: '#f3b842',
  red: '#ff5363',
  green: '#69d391',
};

test('parseTheme accepts known ids and falls back to code', () => {
  for (const theme of THEMES) assert.equal(parseTheme(theme.id), theme.id);
  for (const junk of [null, undefined, '', 'chat ', 'nonsense', '{"a":1}']) assert.equal(parseTheme(junk), 'code');
});

test('THEMES has six entries with unique labels', () => {
  assert.equal(THEMES.length, 6);
  assert.deepEqual(new Set(THEMES.map((t) => t.id)).size, 6);
  for (const theme of THEMES) assert.ok(theme.label.length > 0);
});

test('applyTheme overrides the accent and keeps every other key', () => {
  for (const theme of THEMES.filter((t) => t.id !== 'code')) {
    const resolved = applyTheme(base, theme.id);
    assert.equal(resolved.cyan, theme.accent);
    assert.deepEqual({ ...resolved, cyan: undefined }, { ...base, cyan: undefined });
  }
  assert.deepEqual(applyTheme(base, 'code'), base);
});

test('storage key is stable', () => {
  assert.equal(THEME_STORAGE_KEY, 'ekho:theme');
});
