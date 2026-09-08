import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4096;
const invalid = (message) => Object.assign(new Error(message), { status: 400 });

export async function saveAttachment(directory, body) {
  if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255) throw invalid('Choose a file with a valid name.');
  if (typeof body.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(body.mimeType)) throw invalid('The file type is invalid.');
  if (typeof body.data !== 'string' || body.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || body.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw invalid('Choose a file no larger than 10 MB.');
  const bytes = Buffer.from(body.data, 'base64');
  if (bytes.length > MAX_ATTACHMENT_BYTES || bytes.toString('base64') !== body.data) throw invalid('The file data is invalid or exceeds 10 MB.');
  const name = body.name.replace(/[\/\\\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '_').slice(0, 160) || 'attachment';
  const id = randomUUID();
  const folder = resolve(directory, id);
  const attachment = { id, name, mimeType: body.mimeType, size: bytes.length, path: join(folder, `file-${name}`) };
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(attachment.path, bytes, { mode: 0o600, flag: 'wx' });
    await writeFile(join(folder, 'metadata.json'), JSON.stringify(attachment), { mode: 0o600, flag: 'wx' });
  } catch {
    throw Object.assign(new Error('Could not save the attachment. Check storage on the agent and try again.'), { status: 500 });
  }
  return attachment;
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
