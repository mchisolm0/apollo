import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSkills } from './skills.ts';

test('skills catalog keeps exact invocation names and ignores malformed entries', () => {
  assert.deepEqual(parseSkills({ data: [null, { name: '' }, { name: 42 }, { name: 'creative:design', description: 'Design help', category: 'creative' }, { name: 'notes', description: 1 }] }), [
    { name: 'creative:design', description: 'Design help', category: 'creative' },
    { name: 'notes', description: undefined, category: undefined },
  ]);
  assert.throws(() => parseSkills({ data: {} }), /invalid/);
});
