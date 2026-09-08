import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type DraftAttachment } from '../../lib/attachments';

const draftDirectory = () => new Directory(Paths.document, 'attachment-drafts');

/** Only delete copies created by this picker, never the user's original. */
export function discardAttachment(file: DraftAttachment) {
  if (!file.uri.startsWith(`${draftDirectory().uri.replace(/\/$/, '')}/`)) return;
  try { new File(file.uri).delete(); } catch { /* Already removed or evicted. */ }
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
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const destination = new File(directory, id);
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
