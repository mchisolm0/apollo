import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { File, Directory, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { AppState, Platform } from 'react-native';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';

import { isDraftAttachment, MAX_ATTACHMENTS, type DraftAttachment } from '@/lib/attachments';
import { normalizeIncomingPayloads, shareFingerprint, validateShareSize } from './incoming-share';

export type IncomingShare = Readonly<{ id: string; sourceKey: string; text: string; attachments: readonly DraftAttachment[]; createdAt: number }>;
export type IncomingSharesContextValue = Readonly<{
  pendingShares: readonly IncomingShare[];
  getShare: (id: string) => IncomingShare | undefined;
  acknowledgeShare: (id: string) => Promise<void>;
  discardShare: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  loaded: boolean;
  error?: string;
}>;

const STORAGE_KEY = '@ekho/incoming-shares';
const MAX_PENDING_SHARES = 20;
const shareDirectory = () => new Directory(Paths.document, 'incoming-shares');
const Context = createContext<IncomingSharesContextValue | null>(null);

function validStored(value: unknown): value is IncomingShare[] {
  return Array.isArray(value) && value.length <= MAX_PENDING_SHARES && value.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const share = item as Record<string, unknown>;
    return typeof share.id === 'string' && typeof share.sourceKey === 'string'
      && typeof share.text === 'string' && share.text.length <= 8000
      && typeof share.createdAt === 'number' && Number.isFinite(share.createdAt)
      && Array.isArray(share.attachments) && share.attachments.length <= MAX_ATTACHMENTS && share.attachments.every(isDraftAttachment);
  });
}

function discardOwnFiles(attachments: readonly DraftAttachment[]) {
  const root = `${shareDirectory().uri.replace(/\/$/, '')}/`;
  for (const attachment of attachments) {
    if (!attachment.uri.startsWith(root) || attachment.uri.slice(root.length).includes('/')) continue;
    try { new File(attachment.uri).delete(); } catch { /* A private copy may already be gone. */ }
  }
}

export function IncomingShareProvider({ children }: PropsWithChildren) {
  const [pendingShares, setPendingShares] = useState<IncomingShare[]>([]);
  const records = useRef<IncomingShare[]>([]);
  const [loaded, setLoaded] = useState(false);
  const ready = useRef(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  const operations = useRef(Promise.resolve());

  const serialize = useCallback((operation: () => Promise<void>) => {
    const next = operations.current.then(operation);
    operations.current = next.catch(() => {});
    return next.catch((reason: unknown) => {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Could not save incoming shares.');
      throw reason;
    });
  }, []);
  const publish = useCallback((next: IncomingShare[]) => {
    records.current = next;
    if (mounted.current) { setPendingShares(next); setError(undefined); }
  }, []);
  const persist = useCallback(async (next: IncomingShare[]) => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    publish(next);
  }, [publish]);

  const refresh = useCallback(() => serialize(async () => {
    if (!ready.current) {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      const parsed: unknown = saved === null ? [] : JSON.parse(saved);
      if (!validStored(parsed)) throw new Error('Could not restore incoming shares. The saved content has been kept.');
      publish(parsed);
      ready.current = true;
      if (mounted.current) setLoaded(true);
    }
    if (Platform.OS === 'web') return;
    const raw = Sharing.getSharedPayloads();
    if (!raw.length) return;
    const normalized = normalizeIncomingPayloads(raw);
    const sourceKey = shareFingerprint(raw);
    if (records.current.some((share) => share.sourceKey === sourceKey)) {
      Sharing.clearSharedPayloads();
      return;
    }
    if (records.current.length >= MAX_PENDING_SHARES) throw new Error('Open or discard a pending share before importing another.');
    const destination = shareDirectory();
    destination.create({ idempotent: true, intermediates: true });
    const id = randomUUID();
    const attachments: DraftAttachment[] = [];
    try {
      for (const [index, payload] of normalized.files.entries()) {
        const source = new File(payload.source);
        validateShareSize(source.size);
        const destinationFile = new File(destination, `${id}-${index}-${payload.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100)}`);
        await source.copy(destinationFile);
        const size = destinationFile.size;
        attachments.push({ id: `${id}-${index}`, name: payload.name, mimeType: payload.mimeType, size, uri: destinationFile.uri });
        validateShareSize(size);
      }
      await persist([...records.current, { id, sourceKey, text: normalized.text, attachments, createdAt: Date.now() }]);
    } catch (reason) {
      discardOwnFiles(attachments);
      throw reason;
    }
    // Clear the native handoff only after both the files and metadata are durable.
    Sharing.clearSharedPayloads();
  }), [persist, publish, serialize]);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => {});
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void refresh().catch(() => {}); });
    return () => { mounted.current = false; subscription.remove(); };
  }, [refresh]);

  const acknowledgeShare = useCallback((id: string) => serialize(async () => {
    if (!ready.current) throw new Error('Shared content is still loading.');
    // The destination draft owns the files after acknowledging this handoff.
    await persist(records.current.filter((share) => share.id !== id));
  }), [persist, serialize]);
  const discardShare = useCallback((id: string) => serialize(async () => {
    const share = records.current.find((item) => item.id === id);
    if (!share) return;
    await persist(records.current.filter((item) => item.id !== id));
    discardOwnFiles(share.attachments);
  }), [persist, serialize]);
  const value = useMemo(() => ({ pendingShares, getShare: (id: string) => pendingShares.find((share) => share.id === id), acknowledgeShare, discardShare, refresh, loaded, error }), [acknowledgeShare, discardShare, error, loaded, pendingShares, refresh]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useIncomingShares(): IncomingSharesContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('useIncomingShares must be used within IncomingShareProvider');
  return value;
}
