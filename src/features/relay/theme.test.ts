import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTheme, THEMES, THEME_PALETTES, THEME_STORAGE_KEY } from './theme.ts';

test('parseTheme accepts saved ids and falls back to code', () => {
  for (const theme of THEMES) assert.equal(parseTheme(theme.id), theme.id);
  for (const junk of [null, undefined, '', 'chat ', 'nonsense', '{"a":1}']) assert.equal(parseTheme(junk), 'code');
});

test('THEMES has six distinct ids, labels, and accents', () => {
  assert.equal(THEMES.length, 6);
  assert.equal(new Set(THEMES.map((theme) => theme.id)).size, 6);
  assert.equal(new Set(THEMES.map((theme) => theme.label)).size, 6);
  assert.equal(new Set(THEMES.map((theme) => THEME_PALETTES[theme.id].cyan)).size, 6);
});

function luminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test('every theme has readable text on its dark surfaces and accent', () => {
  for (const { id } of THEMES) {
    const palette = THEME_PALETTES[id];
    for (const role of ['background', 'chrome', 'surface', 'elevated', 'composer', 'selectedThread', 'userBubble', 'codeBackground'] as const) {
      assert.ok(contrast(palette.primary, palette[role]) >= 7, `${id}: primary on ${role}`);
      for (const text of ['secondary', 'muted'] as const) {
        assert.ok(contrast(palette[text], palette[role]) >= 4.5, `${id}: ${text} on ${role}`);
      }
    }
    assert.ok(contrast(palette.accentForeground, palette.cyan) >= 7, `${id}: accent foreground`);
  }
});

test('code keeps its default appearance and storage key', () => {
  assert.equal(THEME_PALETTES.code.background, '#000000');
  assert.equal(THEME_PALETTES.code.primary, '#ffffff');
  assert.equal(THEME_PALETTES.code.cyan, '#a7c8ff');
  assert.equal(THEME_STORAGE_KEY, 'ekho:theme');
});
