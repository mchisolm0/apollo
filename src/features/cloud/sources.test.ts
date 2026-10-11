import assert from 'node:assert/strict';
import test from 'node:test';

import { SOURCES } from '../../../cloud/src/contract.ts';
import { THEME_PALETTES } from '../relay/theme.ts';
import { previewLine } from './card-text.ts';
import { glyphColors, mixHex, SOURCE_STYLES } from './sources.ts';

function luminance(hex: string) {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

test('every source has a label, symbols and glyph colors', () => {
  assert.deepEqual(Object.keys(SOURCE_STYLES).sort(), [...SOURCES].sort());
  assert.equal(mixHex('#ffffff', '#000000', 0.5), '#808080');
  assert.equal(glyphColors('hermes', THEME_PALETTES.iris).foreground, THEME_PALETTES.iris.cyan);
  assert.deepEqual(glyphColors('morning', THEME_PALETTES.code), { background: '#3a2c10', foreground: '#f3b842' });
});

test('glyphs read in every theme: the symbol stands out from its tint, and the tint from the row', () => {
  for (const [theme, palette] of Object.entries(THEME_PALETTES)) {
    for (const source of SOURCES) {
      const { background, foreground } = glyphColors(source, palette);
      assert.ok(contrast(foreground, background) >= 4.5, `${theme}/${source} symbol contrast ${contrast(foreground, background).toFixed(2)}`);
      assert.ok(contrast(background, palette.background) >= 1.2, `${theme}/${source} tint is lost on the background`);
    }
  }
});

test('previews take the first readable line of markdown', () => {
  assert.equal(previewLine('## Staff React Native Engineer\n**Expo** · Remote'), 'Staff React Native Engineer');
  assert.equal(previewLine('\n- Cold start **377 ms** (was 494)\n- Crash-free'), 'Cold start 377 ms (was 494)');
  assert.equal(previewLine('```sh\nrm -rf\n```\n> See [the PR](https://x.dev/1) and `main`'), 'See the PR and main');
  assert.equal(previewLine('1. [x] _Done_ with snake_case_name and *one* thing'), 'Done with snake_case_name and one thing');
  assert.equal(previewLine('---\n\n   '), undefined);
  assert.equal(previewLine(undefined), undefined);
});
