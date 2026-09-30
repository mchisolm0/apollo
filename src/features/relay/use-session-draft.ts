import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { getSessionDraftStore } from '../../lib/session-draft';

const storage = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
};

export function useSessionDraft(agentId: string, sessionId: string) {
  const store = getSessionDraftStore(agentId, sessionId, { storage, uuid: randomUUID });
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => { void store.load(); }, [store]);
  const actions = useMemo(() => ({
    setDraft: store.setDraft.bind(store),
    setAttachments: store.setAttachments.bind(store),
    move: store.move.bind(store),
    appendShare: store.appendShare.bind(store),
    prepareSend: store.prepareSend.bind(store),
    clear: store.clear.bind(store),
    retryLoad: store.retryLoad.bind(store),
  }), [store]);
  return { ...snapshot, ...actions };
}
