import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Keep in sync with MAX_ATTACHMENT_BYTES in src/lib/attachments.ts. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });
const tooLarge = () => fail(413, 'Choose a file no larger than 25 MB.');

/**
 * Streams a raw upload body to disk. The name comes from the query string and the type from
 * Content-Type, so files never pass through base64 or JSON.
 */
export async function saveAttachment(directory, { name, contentType, contentLength, body }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 255) throw fail(400, 'Update Apollo to send attachments.');
  const mimeType = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw fail(400, 'The file type is invalid.');
  if (Number(contentLength) > MAX_ATTACHMENT_BYTES) throw tooLarge();
  const safeName = name.replace(/[\/\\\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '_').slice(0, 160) || 'attachment';
  const id = randomUUID();
  const folder = resolve(directory, id);
  const path = join(folder, `file-${safeName}`);
  let size = 0;
  // Erroring here would destroy the request socket before the 413 is sent, so drain and drop instead.
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      done(null, size > MAX_ATTACHMENT_BYTES ? undefined : chunk);
    },
  });
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await pipeline(body, limit, createWriteStream(path, { mode: 0o600, flags: 'wx' }));
    if (size > MAX_ATTACHMENT_BYTES) throw tooLarge();
    const attachment = { id, name: safeName, mimeType, size, path };
    await writeFile(join(folder, 'metadata.json'), JSON.stringify(attachment), { mode: 0o600, flag: 'wx' });
    return attachment;
  } catch (error) {
    await rm(folder, { recursive: true, force: true }).catch(() => {});
    if (error.status) throw error;
    throw fail(500, 'Could not save the attachment. Check storage on the agent and try again.');
  }
}

export async function readAttachment(directory, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Object.assign(new Error('Attachment not found.'), { status: 404 });
  const folder = resolve(directory, id);
  try {
    const attachment = JSON.parse(await readFile(join(folder, 'metadata.json'), 'utf8'));
    return { attachment, bytes: await readFile(attachment.path) };
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Attachment not found.'), { status: 404 });
    throw error;
  }
}
