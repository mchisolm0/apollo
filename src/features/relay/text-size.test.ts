import assert from 'node:assert/strict';
import test from 'node:test';

import { CODE_SIZE_DEFAULT, TEXT_SIZE_DEFAULT, clampSize, parseCodeSize, parseEnabled, parseTextSize } from './text-size.ts';

test('maps legacy Small/Default/Large values onto the pt slider', () => {
  assert.equal(parseTextSize('small'), 14);
  assert.equal(parseTextSize('default'), TEXT_SIZE_DEFAULT);
  assert.equal(parseTextSize('large'), 20);
});

test('reads stored pt values, clamping anything out of range', () => {
  assert.equal(parseTextSize('18'), 18);
  assert.equal(parseTextSize(21), 21);
  assert.equal(parseTextSize('16.4'), 16);
  assert.equal(parseTextSize('13.4'), 14);
  assert.equal(parseTextSize('4'), 14);
  assert.equal(parseTextSize('99'), 22);
  assert.equal(parseTextSize(null), TEXT_SIZE_DEFAULT);
  assert.equal(parseTextSize('nonsense'), TEXT_SIZE_DEFAULT);
  assert.equal(parseCodeSize('11'), 11);
  assert.equal(parseCodeSize('40'), 18);
  assert.equal(parseCodeSize(undefined), CODE_SIZE_DEFAULT);
  assert.equal(clampSize(9, 10, 18), 10);
  assert.equal(parseEnabled('1'), true);
  assert.equal(parseEnabled('0'), false);
  assert.equal(parseEnabled(undefined), false);
});
