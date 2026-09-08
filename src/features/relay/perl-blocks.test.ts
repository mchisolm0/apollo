import assert from 'node:assert/strict';
import test from 'node:test';
import { perlBlocks } from './perl-blocks.ts';

test('Perl fences highlight during streaming without interpreting fences inside other code', () => {
  assert.deepEqual(perlBlocks('Before\n```perl\nmy $x = 1;\n```\nAfter'), [
    { kind: 'markdown', text: 'Before\n' }, { kind: 'perl', text: 'my $x = 1;' }, { kind: 'markdown', text: 'After' },
  ]);
  assert.deepEqual(perlBlocks('~~~pl\nprint "hello";'), [{ kind: 'perl', text: 'print "hello";' }]);
  const example = '````markdown\n```perl\nmy $x = 1;\n```\n````';
  assert.deepEqual(perlBlocks(example), [{ kind: 'markdown', text: example }]);
});
