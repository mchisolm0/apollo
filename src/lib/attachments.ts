export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
};

export type DraftAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  uri: string;
  uploaded?: Attachment;
};

export type AttachmentSource = { uri: string; headers?: Record<string, string> };

export function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && /^[a-f0-9-]{36}$/.test(item.id)
    && typeof item.name === 'string' && typeof item.mimeType === 'string'
    && typeof item.size === 'number' && item.size >= 0 && item.size <= MAX_ATTACHMENT_BYTES
    && typeof item.path === 'string' && item.path.startsWith('/');
}

export function isDraftAttachment(value: unknown): value is DraftAttachment {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.mimeType === 'string'
    && typeof item.uri === 'string' && item.uri.startsWith('file://')
    && typeof item.size === 'number' && item.size >= 0 && item.size <= MAX_ATTACHMENT_BYTES
    && (item.uploaded === undefined || isAttachment(item.uploaded));
}

const attachmentInstructions = '\n</apollo-attachments>\nThe user attached these files on this machine. Read the files at their paths as needed; for images, use your image-reading tool.';

/** File paths are sent to Hermes, while the chat renders the attachment metadata. */
export function attachmentMessage(text: string, attachments: readonly Attachment[] = []): string {
  if (!attachments.length) return text;
  return `${text}\n\n<apollo-attachments>\n${JSON.stringify(attachments)}${attachmentInstructions}`;
}

export function splitAttachmentMessage(content: string): { text: string; attachments: Attachment[] } {
  const marker = '\n\n<apollo-attachments>\n';
  const index = content.lastIndexOf(marker);
  const end = content.length - attachmentInstructions.length;
  if (index < 0 || end < index || !content.endsWith(attachmentInstructions)) return { text: content, attachments: [] };
  try {
    const value: unknown = JSON.parse(content.slice(index + marker.length, end));
    if (Array.isArray(value) && value.length > 0 && value.length <= MAX_ATTACHMENTS && value.every(isAttachment)) return { text: content.slice(0, index), attachments: value };
  } catch { /* Ordinary user text can contain this marker. */ }
  return { text: content, attachments: [] };
}
