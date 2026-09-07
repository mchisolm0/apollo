import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

/** Drafts stay on this device. Serialize writes so an older save cannot undo Send. */
export function useSessionDraft(agentId: string, sessionId: string) {
  const key = `ekho.draft.${encodeURIComponent(agentId)}.${encodeURIComponent(sessionId)}`;
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const edited = useRef(false);
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(key).then((saved) => {
      if (mounted && !edited.current) setDraft(saved ?? '');
    }).catch(() => { if (mounted) setError('Could not restore the saved draft.'); });
    return () => { mounted = false; };
  }, [key]);
  const update = (value: string) => {
    edited.current = true;
    setDraft(value);
    writes.current = writes.current.then(() => value ? AsyncStorage.setItem(key, value) : AsyncStorage.removeItem(key)).then(() => setError(undefined)).catch(() => setError('Could not save the draft on this device.'));
  };
  // Finish queued edits before moving a new thread draft to its permanent key.
  const move = async (nextSessionId: string, value: string) => {
    if (nextSessionId === sessionId) return;
    await writes.current;
    const nextKey = `ekho.draft.${encodeURIComponent(agentId)}.${encodeURIComponent(nextSessionId)}`;
    if (value) await AsyncStorage.setItem(nextKey, value);
    else await AsyncStorage.removeItem(nextKey);
    await AsyncStorage.removeItem(key);
  };
  return { draft, setDraft: update, move, error };
}
