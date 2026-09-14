import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { useEkho } from '@/lib';

import {
  canSettleSession,
  createSessionInboxProjector,
  isSessionSnoozed,
  pruneSnoozedLedger,
  SNOOZE_DURATION_SECONDS,
  type InboxSettled,
  type InboxSession,
  type InboxSnoozed,
  type SessionInboxState,
} from './session-inbox';

const STORAGE_PREFIX = 'ekho:session-inbox:';

type InboxStoreSnapshot = {
  settled: InboxSettled;
  read: InboxSettled;
  snoozed: InboxSnoozed;
  loaded: boolean;
  error?: string;
};

type InboxStoreEntry = {
  settled: InboxSettled;
  read: InboxSettled;
  snoozed: InboxSnoozed;
  loaded: boolean;
  error?: string;
  snapshot: InboxStoreSnapshot;
  listeners: Set<() => void>;
  load?: Promise<void>;
  migrating?: boolean;
  write: Promise<void>;
};

const entries = new Map<string, InboxStoreEntry>();
const SERVER_SNAPSHOT: InboxStoreSnapshot = { settled: {}, read: {}, snoozed: {}, loaded: false };

function storageKey(agentId: string): string {
  return `${STORAGE_PREFIX}${agentId}`;
}

function entryFor(agentId: string): InboxStoreEntry {
  let entry = entries.get(agentId);
  if (!entry) {
    entry = { settled: {}, read: {}, snoozed: {}, loaded: false, snapshot: { settled: {}, read: {}, snoozed: {}, loaded: false }, listeners: new Set(), write: Promise.resolve() };
    entries.set(agentId, entry);
    entry.load = AsyncStorage.getItem(storageKey(agentId)).then((value) => {
      if (value) {
        try {
          const candidate: unknown = JSON.parse(value);
          if (candidate && typeof candidate === 'object') {
            const data = candidate as Record<string, unknown>;
            const timestamps = (value: unknown): InboxSettled => value && typeof value === 'object'
              ? Object.fromEntries(Object.entries(value).filter(([, timestamp]) => typeof timestamp === 'number' && Number.isFinite(timestamp))) : {};
            entry!.settled = timestamps('settled' in data ? data.settled : data);
            entry!.read = timestamps(data.read);
            entry!.snoozed = pruneSnoozedLedger(timestamps(data.snoozed));
          }
        } catch {
          entry!.error = 'Session inbox data could not be read.';
        }
      }
      entry!.loaded = true;
    }).catch(() => {
      entry!.loaded = true;
      entry!.error = 'Session inbox data could not be read.';
    }).finally(() => {
      entry!.snapshot = { settled: entry!.settled, read: entry!.read, snoozed: entry!.snoozed, loaded: entry!.loaded, error: entry!.error };
      entry!.load = undefined;
      entry!.listeners.forEach((listener) => listener());
    });
  }
  return entry;
}

function subscribe(agentId: string, listener: () => void): () => void {
  const entry = entryFor(agentId);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

function snapshot(agentId: string): InboxStoreSnapshot {
  return entryFor(agentId).snapshot;
}

function update(agentId: string, settled: InboxSettled, read: InboxSettled = entryFor(agentId).read, snoozed: InboxSnoozed = entryFor(agentId).snoozed): Promise<void> {
  const entry = entryFor(agentId);
  entry.settled = settled;
  entry.read = read;
  entry.snoozed = snoozed;
  entry.error = undefined;
  entry.snapshot = { settled, read, snoozed, loaded: entry.loaded };
  entry.listeners.forEach((listener) => listener());
  entry.write = entry.write.then(() => AsyncStorage.setItem(storageKey(agentId), JSON.stringify({ settled, read, snoozed }))).catch(() => {
    entry.error = 'Session inbox changes could not be saved.';
    entry.snapshot = { settled: entry.settled, read: entry.read, snoozed: entry.snoozed, loaded: entry.loaded, error: entry.error };
    entry.listeners.forEach((listener) => listener());
  });
  return entry.write;
}

/** Local-only snooze writes shared with the inbox store. Expired entries are pruned on write. */
async function snoozeInStore(agentId: string, sessionId: string, durationSeconds: number = SNOOZE_DURATION_SECONDS): Promise<boolean> {
  const entry = entryFor(agentId);
  if (!entry.loaded) return false;
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : SNOOZE_DURATION_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  await update(agentId, entry.settled, entry.read, { ...pruneSnoozedLedger(entry.snoozed, now), [sessionId]: now + duration });
  return true;
}

async function unsnoozeInStore(agentId: string, sessionId: string): Promise<boolean> {
  const entry = entryFor(agentId);
  if (!entry.loaded || !isSessionSnoozed(entry.snoozed, sessionId)) return false;
  const next = { ...entry.snoozed };
  delete next[sessionId];
  await update(agentId, entry.settled, entry.read, next);
  return true;
}

export type SessionInboxActions = {
  markRead: (sessionId: string) => Promise<void>;
  settle: (sessionId: string) => Promise<boolean>;
  reopen: (sessionId: string) => Promise<boolean>;
  snooze: (sessionId: string, durationSeconds?: number) => Promise<boolean>;
  unsnooze: (sessionId: string) => Promise<boolean>;
};

export type SessionInboxResult = {
  sessions: InboxSession[];
  snoozed: InboxSnoozed;
  loaded: boolean;
  error?: string;
} & SessionInboxActions;

/** Reads stay local; legacy settle entries migrate to the shared connector ledger. */
export function useSessionInbox(agentId: string, state: SessionInboxState | undefined): SessionInboxResult {
  const { saveInbox } = useEkho();
  const store = useSyncExternalStore(
    useCallback((listener) => subscribe(agentId, listener), [agentId]),
    useCallback(() => snapshot(agentId), [agentId]),
    useCallback(() => SERVER_SNAPSHOT, []),
  );
  const project = useMemo(() => createSessionInboxProjector(), []);
  const sessions = useMemo(() => project(agentId, state, store.settled, store.read), [project, agentId, state, store.settled, store.read]);

  const reportError = useCallback((cause: unknown) => {
    const entry = entryFor(agentId);
    entry.error = cause instanceof Error ? cause.message : 'Finished threads could not be synced.';
    entry.snapshot = { ...entry.snapshot, error: entry.error };
    entry.listeners.forEach((listener) => listener());
  }, [agentId]);

  useEffect(() => {
    const entry = entryFor(agentId);
    if (!store.loaded || !state?.sessions.length || entry.migrating || !Object.keys(store.settled).length) return;
    const legacy = store.settled;
    entry.migrating = true;
    void saveInbox(agentId, legacy, true).then(async () => {
      const remaining = { ...entry.settled };
      for (const [id, timestamp] of Object.entries(legacy)) if (remaining[id] === timestamp) delete remaining[id];
      await update(agentId, remaining);
    }).catch(reportError).finally(() => { entry.migrating = false; });
  }, [agentId, state?.sessions, store.loaded, store.settled, saveInbox, reportError]);

  const markRead = useCallback(async (sessionId: string): Promise<void> => {
    if (!store.loaded) return;
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.running || session.pendingApproval) return;
    const current = entryFor(agentId);
    if ((current.read[sessionId] ?? -1) >= session.activityAt) return;
    await update(agentId, current.settled, { ...current.read, [sessionId]: session.activityAt });
  }, [agentId, sessions, store.loaded]);

  const settle = useCallback(async (sessionId: string): Promise<boolean> => {
    if (!store.loaded) return false;
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session || !canSettleSession(session)) return false;
    try {
      await saveInbox(agentId, { [sessionId]: session.activityAt || Math.floor(Date.now() / 1000) });
      await update(agentId, entryFor(agentId).settled);
      return true;
    } catch (cause) { reportError(cause); return false; }
  }, [agentId, sessions, store.loaded, saveInbox, reportError]);

  const reopen = useCallback(async (sessionId: string): Promise<boolean> => {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!store.loaded || !session?.settled) return false;
    try {
      await saveInbox(agentId, { [sessionId]: null });
      const next = { ...entryFor(agentId).settled };
      delete next[sessionId];
      await update(agentId, next);
      return true;
    } catch (cause) { reportError(cause); return false; }
  }, [agentId, sessions, store.loaded, saveInbox, reportError]);

  const snooze = useCallback(async (sessionId: string, durationSeconds?: number): Promise<boolean> => {
    return snoozeInStore(agentId, sessionId, durationSeconds);
  }, [agentId]);

  const unsnooze = useCallback(async (sessionId: string): Promise<boolean> => {
    return unsnoozeInStore(agentId, sessionId);
  }, [agentId]);

  return { sessions, snoozed: store.snoozed, loaded: store.loaded, error: store.error, markRead, settle, reopen, snooze, unsnooze };
}

/** Standalone access to the local-only snooze ledger for views that receive sessions as props. */
export function useSnoozeLedger(agentId: string): {
  snoozed: InboxSnoozed;
  loaded: boolean;
  snooze: (sessionId: string, durationSeconds?: number) => Promise<boolean>;
  unsnooze: (sessionId: string) => Promise<boolean>;
} {
  const store = useSyncExternalStore(
    useCallback((listener) => subscribe(agentId, listener), [agentId]),
    useCallback(() => snapshot(agentId), [agentId]),
    useCallback(() => SERVER_SNAPSHOT, []),
  );
  const snooze = useCallback(async (sessionId: string, durationSeconds?: number): Promise<boolean> => {
    return snoozeInStore(agentId, sessionId, durationSeconds);
  }, [agentId]);
  const unsnooze = useCallback(async (sessionId: string): Promise<boolean> => {
    return unsnoozeInStore(agentId, sessionId);
  }, [agentId]);
  return { snoozed: store.snoozed, loaded: store.loaded, snooze, unsnooze };
}
