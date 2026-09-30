import assert from 'node:assert/strict';
import test from 'node:test';

import { parseUnifiedDiff, splitDiffFences } from './diff-parser.ts';

test('extracts fenced diffs and preserves surrounding markdown', () => {
  assert.deepEqual(splitDiffFences('Before\n\n```diff\n@@ -1 +1 @@\n-old\n+new\n```\n\nAfter').map((part) => part.kind), ['markdown', 'diff', 'markdown']);
});

test('parses unified diff line numbers and totals', () => {
  const rows = parseUnifiedDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2,2 +2,2 @@\n same\n-old\n+new');
  assert.deepEqual(rows[0], { kind: 'file', id: 'diff:0:a.ts:file', fileId: 'diff:0:a.ts', filePath: 'a.ts', previousPath: 'a.ts', changeType: 'modified', additions: 1, deletions: 1 });
  assert.deepEqual(rows.slice(-2).map(({ change, oldLineNumber, newLineNumber }) => ({ change, oldLineNumber, newLineNumber })), [
    { change: 'delete', oldLineNumber: 3, newLineNumber: null },
    { change: 'add', oldLineNumber: null, newLineNumber: 3 },
  ]);
});
