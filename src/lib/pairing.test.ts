import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePairingLink } from './pairing.ts';

test('does not decode already decoded query or fragment parameters twice', () => {
  const result = parsePairingLink('apollo://pair?host=https%3A%2F%2Fexample.com%2F%252Fagent#token=abc%252Fdef');

  assert.equal(result.endpoint, 'https://example.com/%2Fagent');
  assert.equal(result.bootstrapToken, 'abc%2Fdef');
});

test('decodes an unparameterized raw fragment token once', () => {
  const result = parsePairingLink('apollo://pair?endpoint=https%3A%2F%2Flocalhost%3A8643#abc%252Fdef');

  assert.equal(result.endpoint, 'https://localhost:8643');
  assert.equal(result.bootstrapToken, 'abc%2Fdef');
});
