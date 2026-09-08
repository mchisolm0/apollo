import test from 'node:test';
import assert from 'node:assert/strict';
import { saveAttachment, MAX_ATTACHMENT_BYTES } from './attachments.mjs';

test('rejects oversized bytes and invalid MIME before storing an upload', async () => {
  await assert.rejects(saveAttachment('/unused', { name: 'large.bin', mimeType: 'application/octet-stream', data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }), { status: 400 });
  await assert.rejects(saveAttachment('/unused', { name: 'header.txt', mimeType: 'text/plain\r\nx-bad: header', data: '' }), { status: 400 });
});
