import assert from 'node:assert/strict';
import test from 'node:test';

import { pastedTextFileName, withoutAttachmentCharacters } from './composer-paste.ts';

test('folded pastes get the next free name', () => {
  assert.equal(pastedTextFileName([]), 'pasted-text.txt');
  assert.equal(pastedTextFileName(['photo.png', 'Pasted-Text.txt']), 'pasted-text-2.txt');
  assert.equal(pastedTextFileName(['pasted-text.txt', 'pasted-text-2.txt', 'pasted-text-4.txt']), 'pasted-text-3.txt');
});

test('attachment placeholders never reach the draft', () => {
  assert.equal(withoutAttachmentCharacters('fix the build\uFFFC'), 'fix the build');
  assert.equal(withoutAttachmentCharacters('\uFFFC').trim(), '');
  assert.equal(withoutAttachmentCharacters('a\uFFFCb $review '), 'ab $review ');
});
