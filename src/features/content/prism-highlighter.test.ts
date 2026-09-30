import assert from 'node:assert/strict';
import test from 'node:test';

import { highlightCode } from './prism-highlighter.ts';

const colors = { cyan: '#00f', green: '#0f0', amber: '#fa0', muted: '#888', codeText: '#fff' };

test('maps Prism tokens to native lines without losing source text', () => {
  const source = 'const answer: number = 42;\n// done';
  const lines = highlightCode(source, 'typescript', colors);
  assert.equal(lines.map((line) => line.map((token) => token.content).join('')).join('\n'), source);
  assert.ok(lines.flat().some((token) => token.color === colors.cyan));
  assert.ok(lines[1].every((token) => token.color === colors.muted));
});
