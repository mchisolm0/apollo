import { isDraftAttachment, MAX_ATTACHMENTS, type DraftAttachment } from '../../lib/attachments';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

/** Drafts stay on this device. Serialize writes so an older save cannot undo Send. */
export function useSessionDraft(agentId: string, sessionId: string) {
  const key = `ekho.draft.${encodeURIComponent(agentId)}.${encodeURIComponent(sessionId)}`;
  const [draft, setDraft] = useState('');
  const [attachments, setAttachmentState] = useState<readonly DraftAttachment[]>([]);
  const attachmentsEdited = useRef(false);
  const [error, setError] = useState<string>();
  const edited = useRef(false);
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(key).then((saved) => {
      if (mounted && !edited.current) setDraft(saved ?? '');
    }).catch(() => { if (mounted) setError('Could not restore the saved draft.'); });
    void AsyncStorage.getItem(`${key}:attachments`).then((saved) => {
      if (!mounted || attachmentsEdited.current || !saved) return;
      const value: unknown = JSON.parse(saved);
      if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS || !value.every(isDraftAttachment)) throw new Error('Invalid attachments');
      setAttachmentState(value);
    }).catch(() => { if (mounted) setError('Could not restore attachments. Add the files again.'); });
    return () => { mounted = false; };
  }, [key]);
  const update = (value: string) => {
    edited.current = true;
    setDraft(value);
    writes.current = writes.current.then(() => value ? AsyncStorage.setItem(key, value) : AsyncStorage.removeItem(key)).then(() => setError(undefined)).catch(() => setError('Could not save the draft on this device.'));
  };
  const setAttachments = (files: readonly DraftAttachment[]) => {
    attachmentsEdited.current = true;
    setAttachmentState(files);
    writes.current = writes.current.then(() => files.length ? AsyncStorage.setItem(`${key}:attachments`, JSON.stringify(files)) : AsyncStorage.removeItem(`${key}:attachments`)).then(() => setError(undefined)).catch(() => setError('Could not save attachments on this device.'));
  };
  // Finish queued edits before moving a new thread draft to its permanent key.
  const move = async (nextSessionId: string, value: string, files: readonly DraftAttachment[] = attachments) => {
    if (nextSessionId === sessionId) return;
    await writes.current;
    const nextKey = `ekho.draft.${encodeURIComponent(agentId)}.${encodeURIComponent(nextSessionId)}`;
    if (value) await AsyncStorage.setItem(nextKey, value);
    else await AsyncStorage.removeItem(nextKey);
    if (files.length) await AsyncStorage.setItem(`${nextKey}:attachments`, JSON.stringify(files));
    else await AsyncStorage.removeItem(`${nextKey}:attachments`);
    await AsyncStorage.multiRemove([key, `${key}:attachments`]);
  };
  return { draft, setDraft: update, attachments, setAttachments, move, error };
}
