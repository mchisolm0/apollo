import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeIncomingPayloads, shareFingerprint, validateShareSize } from '../features/sharing/incoming-share.ts';

test('normalizes text, URLs, and local files without fetching URLs', () => {
  const payloads = [{ value: 'https://example.com', shareType: 'url' }, { value: 'file:///tmp/a.pdf', shareType: 'file', mimeType: 'application/pdf' }];
  assert.deepEqual(normalizeIncomingPayloads(payloads), { text: 'https://example.com', files: [{ source: 'file:///tmp/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' }] });
  assert.equal(shareFingerprint(payloads), shareFingerprint(payloads));
  assert.throws(() => normalizeIncomingPayloads([{ value: 'https://example.com', shareType: 'image' }]));
});

test('rejects files above the existing attachment limit', () => {
  validateShareSize(10 * 1024 * 1024);
  assert.throws(() => validateShareSize(10 * 1024 * 1024 + 1));
});
