import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { saveAttachment, MAX_ATTACHMENT_BYTES } from './attachments.mjs';

test('rejects invalid uploads and leaves nothing behind when the stream runs over the limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apollo-attachments-'));
  const upload = (overrides) => saveAttachment(directory, { name: 'large.bin', contentType: 'application/octet-stream', body: Readable.from([]), ...overrides });
  await assert.rejects(upload({ contentType: 'text/plain\r\nx-bad: header' }), { status: 400 });
  await assert.rejects(upload({ contentLength: String(MAX_ATTACHMENT_BYTES + 1) }), { status: 413 });
  const chunk = Buffer.alloc(1024 * 1024);
  await assert.rejects(upload({ body: Readable.from(Array.from({ length: 26 }, () => chunk)) }), { status: 413 });
  assert.deepEqual(await readdir(directory), []);
  const saved = await upload({ name: 'notes.txt', contentType: 'text/plain; charset=utf-8', body: Readable.from([Buffer.from('hi')]) });
  assert.deepEqual([saved.mimeType, saved.size], ['text/plain', 2]);
});
