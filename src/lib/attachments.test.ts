import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentMessage, splitAttachmentMessage, type Attachment } from './attachments.ts';

const file: Attachment = { id: '12345678-1234-1234-1234-123456789abc', name: 'notes.txt', mimeType: 'text/plain', size: 42, path: '/private/attachments/file-notes.txt' };

test('attachment prompts round-trip text and file-only messages for history rendering', () => {
  for (const text of ['', 'Read this file.\nKeep the original formatting.']) {
    const prompt = attachmentMessage(text, [file]);
    assert.ok(prompt.includes(file.path));
    assert.deepEqual(splitAttachmentMessage(prompt), { text, attachments: [file] });
  }
  assert.equal(attachmentMessage('Ordinary text'), 'Ordinary text');
});

test('history written before the Apollo rename still renders its attachments', () => {
  const legacy = attachmentMessage('Read this.', [file]).replaceAll('apollo-attachments', 'ekho-attachments');
  assert.deepEqual(splitAttachmentMessage(legacy), { text: 'Read this.', attachments: [file] });
});

test('ordinary or malformed marker text stays visible', () => {
  for (const content of ['hello', '\n\n<apollo-attachments>\nnot JSON\n</apollo-attachments>', attachmentMessage('hello', [file]) + '\nMore user text', attachmentMessage('hello', [{ ...file, path: 'relative/path' }])]) {
    assert.deepEqual(splitAttachmentMessage(content), { text: content, attachments: [] });
  }
});
