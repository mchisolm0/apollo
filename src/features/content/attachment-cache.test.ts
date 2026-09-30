import assert from 'node:assert/strict';
import test from 'node:test';

import { attachmentCacheIdentity } from './attachment-cache.ts';

test('cache identity scopes attachment IDs by origin and path without URL secrets', () => {
  const identity = attachmentCacheIdentity('https://one.example/v1/ekho/attachments/same?token=secret', 'same');
  assert.equal(identity, 'https://one.example/v1/ekho/attachments/same\0same');
  assert.notEqual(identity, attachmentCacheIdentity('https://two.example/v1/ekho/attachments/same', 'same'));
  assert.ok(!identity.includes('secret'));
});
