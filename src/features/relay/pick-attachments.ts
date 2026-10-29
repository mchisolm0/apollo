import { randomUUID } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import { attachmentTooLargeMessage, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type DraftAttachment } from '../../lib/attachments';
import { fitImage } from '../attachments/fit-image';
import { imageNameForFormat } from '../attachments/image-fit';

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
    if (new File(file.uri).size > MAX_ATTACHMENT_BYTES) throw new Error(attachmentTooLargeMessage);
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

type PickedFile = { uri: string; name: string; mimeType: string };

const tooMany = (remaining: number) => new Error(remaining <= 0
  ? `You can attach up to ${MAX_ATTACHMENTS} files per message.`
  : `Choose up to ${remaining} more ${remaining === 1 ? 'file' : 'files'}.`);

/** Copies a picked file into the draft directory, downscaling images that are too large to send. */
async function addDraftFile(picked: PickedFile): Promise<DraftAttachment> {
  const source = new File(picked.uri);
  const bytes = source.size;
  const image = picked.mimeType.startsWith('image/');
  // Large images usually fit once downscaled, so only their result is held to the limit.
  if (!image && bytes > MAX_ATTACHMENT_BYTES) throw new Error(attachmentTooLargeMessage);
  // A failed render keeps the original, as T3 does; the size check below still applies.
  const fitted = image ? await fitImage({ uri: picked.uri, mimeType: picked.mimeType, bytes }).catch(() => null) : null;
  if (!fitted && bytes > MAX_ATTACHMENT_BYTES) throw new Error(attachmentTooLargeMessage);
  const name = fitted ? imageNameForFormat(picked.name, fitted.format) : picked.name;
  const id = randomUUID();
  const directory = draftDirectory();
  directory.create({ intermediates: true, idempotent: true });
  const destination = new File(directory, `${id}${/\.[a-zA-Z0-9]{1,10}$/.exec(name)?.[0] ?? ''}`);
  try {
    await (fitted ? new File(fitted.uri) : source).copy(destination);
    if (destination.size > MAX_ATTACHMENT_BYTES) throw new Error(attachmentTooLargeMessage);
    return { id, name, mimeType: fitted ? `image/${fitted.format}` : picked.mimeType, size: destination.size, uri: destination.uri };
  } catch (error) {
    if (destination.exists) destination.delete();
    throw error;
  } finally {
    if (fitted) try { new File(fitted.uri).delete(); } catch { /* The cache may already be cleared. */ }
  }
}

async function addDraftFiles(picked: readonly PickedFile[], remaining: number): Promise<DraftAttachment[]> {
  if (picked.length > remaining) throw tooMany(remaining);
  const files: DraftAttachment[] = [];
  try {
    for (const file of picked) files.push(await addDraftFile(file));
    return files;
  } catch (error) {
    files.forEach(discardAttachment);
    throw error;
  }
}

/** Copies image URIs emitted by expo-paste-input into durable app storage. */
export async function persistPastedImages(uris: readonly string[], remaining: number): Promise<DraftAttachment[]> {
  if (uris.some((uri) => !uri.startsWith('file://'))) throw new Error('Pasted images must come from a local file.');
  return addDraftFiles(uris.map((uri, index) => {
    const extension = /\.(jpe?g|gif|webp)$/i.exec(uri)?.[0].toLowerCase() ?? '.png';
    const mimeType = extension === '.gif' ? 'image/gif' : extension === '.webp' ? 'image/webp' : extension === '.png' ? 'image/png' : 'image/jpeg';
    return { uri, name: `pasted-image-${index + 1}${extension}`, mimeType };
  }), remaining);
}

export async function pickAttachments(kind: 'photos' | 'files', remaining: number): Promise<DraftAttachment[]> {
  if (remaining <= 0) throw tooMany(remaining);
  if (kind === 'photos') {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: remaining, quality: 1, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
    if (result.canceled) return [];
    return addDraftFiles(result.assets.map((asset) => ({ uri: asset.uri, name: asset.fileName?.trim() || new File(asset.uri).name, mimeType: asset.mimeType ?? 'image/jpeg' })), remaining);
  }
  // The picker copies into the cache so expo-file-system can read provider-owned files.
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return [];
  return addDraftFiles(result.assets.map((asset) => ({ uri: asset.uri, name: asset.name.trim() || 'file', mimeType: asset.mimeType || 'application/octet-stream' })), remaining);
}
