import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '../../lib/attachments.ts';

export type RawIncomingPayload = Readonly<{ value: string; shareType: string; mimeType?: string }>;

export type NormalizedShare = Readonly<{
  text: string;
  files: readonly Readonly<{ source: string; name: string; mimeType: string; size?: number }>[];
}>;

export function normalizeIncomingPayloads(payloads: readonly RawIncomingPayload[]): NormalizedShare {
  if (!payloads.length) throw new Error('No share content was received.');
  const text: string[] = [];
  const files: { source: string; name: string; mimeType: string; size?: number }[] = [];
  for (const payload of payloads) {
    if (!payload || !payload.value || typeof payload.value !== 'string') throw new Error('The shared content was empty.');
    if (payload.shareType === 'text' || payload.shareType === 'url') text.push(payload.value);
    else if (['image', 'file', 'audio', 'video'].includes(payload.shareType)) {
      if (!/^file:\/\//.test(payload.value) && !/^content:\/\//.test(payload.value)) throw new Error('Only local shared files can be imported.');
      const name = payload.value.split('/').pop() || `shared-${files.length + 1}`;
      files.push({ source: payload.value, name, mimeType: payload.mimeType || 'application/octet-stream' });
    } else throw new Error('This shared content type is not supported.');
  }
  if (!text.length && !files.length) throw new Error('The shared content was empty.');
  if (files.length > MAX_ATTACHMENTS) throw new Error(`Share up to ${MAX_ATTACHMENTS} files at a time.`);
  const joinedText = [...new Set(text)].join('\n\n');
  if (joinedText.length > 8000) throw new Error('Shared text must be 8,000 characters or fewer.');
  return { text: joinedText, files };
}

export function shareFingerprint(payloads: readonly RawIncomingPayload[]): string {
  // Exact identity avoids dropping a share because a short hash collided.
  return JSON.stringify(payloads.map(({ value, shareType, mimeType }) => [shareType, mimeType ?? '', value]));
}

export function validateShareSize(size: number): void {
  if (!Number.isFinite(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) throw new Error('Shared files must be 10 MB or smaller.');
}
