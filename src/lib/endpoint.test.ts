import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEndpoint } from './endpoint.ts';

test('requires encrypted remote endpoints while allowing loopback development', () => {
  assert.equal(normalizeEndpoint('https://agent.tailnet.ts.net/'), 'https://agent.tailnet.ts.net');
  assert.equal(normalizeEndpoint('http://127.0.0.1:18643'), 'http://127.0.0.1:18643');
  assert.equal(normalizeEndpoint('http://[::1]:18643'), 'http://[::1]:18643');
  for (const value of ['http://192.168.1.2', 'http://example.com', 'http://localhost.example.com', 'file:///tmp/test', 'https://user:password@example.com']) assert.throws(() => normalizeEndpoint(value));
});
