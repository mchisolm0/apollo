import assert from 'node:assert/strict';
import test from 'node:test';
import { generateThreadTitle } from './thread-title.mjs';

test('a host without Codex returns no title without an unhandled spawn error', async () => {
  const path = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.equal(await generateThreadTitle('Count files'), undefined);
  } finally {
    process.env.PATH = path;
  }
});
