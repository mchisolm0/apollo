import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { randomUUID } from 'expo-crypto';

import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type DraftAttachment } from '../../lib/attachments';

const draftDirectory = () => new Directory(Paths.document, 'attachment-drafts');
const incomingShareDirectory = () => new Directory(Paths.document, 'incoming-shares');

function isOwnedAttachmentUri(uri: string): boolean {
  const roots = [draftDirectory().uri, incomingShareDirectory().uri].map((root) => root.replace(/\/$/, ''));
  return roots.some((root) => {
    if (!uri.startsWith(`${root}/`)) return false;
    const name = uri.slice(root.length + 1);
    return /^[a-zA-Z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
  });
}

/** Copies provider-owned share files into the draft directory with stable paths. */
export async function copySharedAttachments(shareId: string, files: readonly DraftAttachment[]): Promise<DraftAttachment[]> {
  const incomingRoot = `${incomingShareDirectory().uri.replace(/\/$/, '')}/`;
  const directory = draftDirectory();
  directory.create({ intermediates: true, idempotent: true });
  const copied: DraftAttachment[] = [];
  for (const file of files) {
    if (!file.uri.startsWith(incomingRoot) || file.uri.slice(incomingRoot.length).includes('/')) throw new Error('The shared attachment is not an app-owned file.');
    const id = `share-${shareId}-${file.id}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    const destination = new File(directory, `${id}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100)}`);
    if (new File(file.uri).size > MAX_ATTACHMENT_BYTES) throw new Error('Choose files no larger than 10 MB each.');
    if (!destination.exists) await new File(file.uri).copy(destination);
    copied.push({ ...file, id, uri: destination.uri, size: destination.size });
  }
  return copied;
}

/** Only delete copies created by this picker, never the user's original. */
export function discardAttachment(file: DraftAttachment) {
  if (!isOwnedAttachmentUri(file.uri)) return;
  try { new File(file.uri).delete(); } catch { /* Already removed or evicted. */ }
}

/** Copies image URIs emitted by expo-paste-input into durable app storage. */
export async function persistPastedImages(uris: readonly string[], remaining: number): Promise<DraftAttachment[]> {
  if (uris.length > remaining || uris.length > MAX_ATTACHMENTS) throw new Error(`Choose up to ${Math.max(0, Math.min(remaining, MAX_ATTACHMENTS))} more ${Math.min(remaining, MAX_ATTACHMENTS) === 1 ? 'file' : 'files'}.`);
  const directory = draftDirectory();
  directory.create({ intermediates: true, idempotent: true });
  const files: DraftAttachment[] = [];
  try {
    for (const [index, uri] of uris.entries()) {
      if (!uri.startsWith('file://')) throw new Error('Pasted images must come from a local file.');
      const source = new File(uri);
      const size = source.info().size ?? source.size;
      if (size > MAX_ATTACHMENT_BYTES) throw new Error('Choose files no larger than 10 MB each.');
      const id = randomUUID();
      const extension = ['.jpg', '.jpeg', '.gif', '.webp'].includes(source.extension.toLowerCase()) ? source.extension.toLowerCase() : '.png';
      const mimeType = extension === '.gif' ? 'image/gif' : extension === '.webp' ? 'image/webp' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
      const destination = new File(directory, `${id}-${index}${extension}`);
      await source.copy(destination);
      const file = { id, name: `pasted-image-${index + 1}${extension}`, mimeType, size: destination.size, uri: destination.uri };
      files.push(file);
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Choose files no larger than 10 MB each.');
    }
    return files;
  } catch (error) {
    files.forEach(discardAttachment);
    throw error;
  }
}

export async function pickAttachments(kind: 'photos' | 'files', remaining: number): Promise<DraftAttachment[]> {
  if (remaining <= 0) throw new Error(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
  let selected: { uri: string; name: string; mimeType: string; size: number }[];
  if (kind === 'photos') {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: remaining, quality: 1, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
    if (result.canceled) return [];
    selected = result.assets.map((asset) => ({ uri: asset.uri, name: asset.fileName ?? new File(asset.uri).name, mimeType: asset.mimeType ?? 'image/jpeg', size: asset.fileSize ?? new File(asset.uri).size }));
  } else {
    const result = await File.pickFileAsync({ multipleFiles: true });
    if (result.canceled) return [];
    selected = result.result.map((file) => ({ uri: file.uri, name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size }));
  }
  if (selected.length > remaining) throw new Error(`Choose up to ${remaining} more ${remaining === 1 ? 'file' : 'files'}.`);
  if (selected.some((file) => file.size > MAX_ATTACHMENT_BYTES)) throw new Error('Choose files no larger than 10 MB each.');
  const directory = draftDirectory();
  directory.create({ intermediates: true, idempotent: true });
  const files: DraftAttachment[] = [];
  try {
    for (const selectedFile of selected) {
      const id = randomUUID();
      const extension = /\.[a-zA-Z0-9]{1,10}$/.exec(selectedFile.name)?.[0] ?? '';
      const destination = new File(directory, `${id}${extension}`);
      await new File(selectedFile.uri).copy(destination);
      const file = { ...selectedFile, size: destination.size, uri: destination.uri, id };
      files.push(file);
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Choose files no larger than 10 MB each.');
    }
    return files;
  } catch (error) {
    files.forEach(discardAttachment);
    throw error;
  }
}
