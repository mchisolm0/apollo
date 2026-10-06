import { posthog } from '@/config/posthog';
import { useOutbox } from '../../lib/outbox-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { useApollo, type InboxConfig, type InboxSettledState } from '@/lib';

import {
  canSettleSession,
  createSessionInboxProjector,
  isAutoSettleDue,
  isSessionSnoozed,
  pruneSnoozedLedger,
  SNOOZE_DURATION_SECONDS,
  type InboxSettled,
  type InboxSession,
  type InboxSnoozed,
  type SessionInboxState,
} from './session-inbox';

const STORAGE_PREFIX = 'apollo:session-inbox:';

/** Session id -> auto-settle opted out. Absent means on (the default). Shared via the connector. */
type InboxAutoSettle = Readonly<Record<string, boolean>>;

type InboxStoreSnapshot = {
  settled: InboxSettled;
  read: InboxSettled;
  snoozed: InboxSnoozed;
  autoSettleDisabled: InboxAutoSettle;
  loaded: boolean;
  error?: string;
};

type InboxStoreEntry = {
  settled: InboxSettled;
  read: InboxSettled;
  snoozed: InboxSnoozed;
  autoSettleDisabled: InboxAutoSettle;
  loaded: boolean;
  error?: string;
  snapshot: InboxStoreSnapshot;
  listeners: Set<() => void>;
  load?: Promise<void>;
  migrating?: boolean;
  write: Promise<void>;
};

const entries = new Map<string, InboxStoreEntry>();
const SERVER_SNAPSHOT: InboxStoreSnapshot = { settled: {}, read: {}, snoozed: {}, autoSettleDisabled: {}, loaded: false };

function storageKey(agentId: string): string {
  return `${STORAGE_PREFIX}${agentId}`;
}

function entryFor(agentId: string): InboxStoreEntry {
  let entry = entries.get(agentId);
  if (!entry) {
    entry = { settled: {}, read: {}, snoozed: {}, autoSettleDisabled: {}, loaded: false, snapshot: { settled: {}, read: {}, snoozed: {}, autoSettleDisabled: {}, loaded: false }, listeners: new Set(), write: Promise.resolve() };
    entries.set(agentId, entry);
    entry.load = AsyncStorage.getItem(storageKey(agentId)).then((value) => {
      if (value) {
        try {
          const candidate: unknown = JSON.parse(value);
          if (candidate && typeof candidate === 'object') {
            const data = candidate as Record<string, unknown>;
            const timestamps = (value: unknown): InboxSettled => value && typeof value === 'object'
              ? Object.fromEntries(Object.entries(value).filter(([, timestamp]) => typeof timestamp === 'number' && Number.isFinite(timestamp))) : {};
            const flags = (value: unknown): InboxAutoSettle => value && typeof value === 'object'
              ? Object.fromEntries(Object.entries(value).filter((flag): flag is [string, true] => flag[1] === true)) : {};
            entry!.settled = timestamps('settled' in data ? data.settled : data);
            entry!.read = timestamps(data.read);
            entry!.snoozed = pruneSnoozedLedger(timestamps(data.snoozed));
            entry!.autoSettleDisabled = flags(data.autoSettleDisabled);
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
      entry!.snapshot = { settled: entry!.settled, read: entry!.read, snoozed: entry!.snoozed, autoSettleDisabled: entry!.autoSettleDisabled, loaded: entry!.loaded, error: entry!.error };
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

function update(agentId: string, settled: InboxSettled, read: InboxSettled = entryFor(agentId).read, snoozed: InboxSnoozed = entryFor(agentId).snoozed, autoSettleDisabled: InboxAutoSettle = entryFor(agentId).autoSettleDisabled): Promise<void> {
  const entry = entryFor(agentId);
  entry.settled = settled;
  entry.read = read;
  entry.snoozed = snoozed;
  entry.autoSettleDisabled = autoSettleDisabled;
  entry.error = undefined;
  entry.snapshot = { settled, read, snoozed, autoSettleDisabled, loaded: entry.loaded };
  entry.listeners.forEach((listener) => listener());
  entry.write = entry.write.then(() => AsyncStorage.setItem(storageKey(agentId), JSON.stringify({ settled, read, snoozed, autoSettleDisabled }))).catch(() => {
    entry.error = 'Session inbox changes could not be saved.';
    entry.snapshot = { settled: entry.settled, read: entry.read, snoozed: entry.snoozed, autoSettleDisabled: entry.autoSettleDisabled, loaded: entry.loaded, error: entry.error };
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

/** Re-render at the next snooze expiry so expired threads leave the Snoozed section on their own. */
function useSnoozeExpiry(agentId: string, snoozed: InboxSnoozed) {
  useEffect(() => {
    const now = Math.floor(Date.now() / 1000);
    let next: number | undefined;
    for (const until of Object.values(snoozed)) {
      if (until > now && (next === undefined || until < next)) next = until;
    }
    if (next === undefined) return;
    const timer = setTimeout(() => {
      const entry = entryFor(agentId);
      const pruned = pruneSnoozedLedger(entry.snoozed);
      if (Object.keys(pruned).length !== Object.keys(entry.snoozed).length) {
        void update(agentId, entry.settled, entry.read, pruned);
      } else {
        entry.listeners.forEach((listener) => listener());
      }
    }, Math.max(0, next * 1000 - Date.now() + 50));
    return () => clearTimeout(timer);
  }, [agentId, snoozed]);
}

export type SessionInboxActions = {
  markRead: (sessionId: string) => Promise<void>;
  settle: (sessionId: string) => Promise<boolean>;
  reopen: (sessionId: string) => Promise<boolean>;
  snooze: (sessionId: string, durationSeconds?: number) => Promise<boolean>;
  unsnooze: (sessionId: string) => Promise<boolean>;
  setAutoSettle: (sessionId: string, enabled: boolean) => Promise<boolean>;
};

export type SessionInboxResult = {
  sessions: InboxSession[];
  snoozed: InboxSnoozed;
  loaded: boolean;
  error?: string;
} & SessionInboxActions;

/** Reads stay local; legacy settle entries migrate to the shared connector ledger. */
export function useSessionInbox(agentId: string, state: SessionInboxState | undefined): SessionInboxResult {
  const { saveInbox } = useApollo();
  const { items } = useOutbox();
  const store = useSyncExternalStore(
    useCallback((listener) => subscribe(agentId, listener), [agentId]),
    useCallback(() => snapshot(agentId), [agentId]),
    useCallback(() => SERVER_SNAPSHOT, []),
  );
  const project = useMemo(() => createSessionInboxProjector(), []);
  const sessions = useMemo(() => {
    const queued = new Set(items.filter((item) => item.agentId === agentId).map((item) => item.sessionId));
    return project(agentId, state, store.settled, store.read, store.autoSettleDisabled).map((session) => queued.has(session.id) ? { ...session, queued: true } : session);
  }, [project, agentId, state, store.settled, store.read, store.autoSettleDisabled, items]);
  useSnoozeExpiry(agentId, store.snoozed);

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
      posthog.capture('session_settled', { agent_id: agentId, session_id: sessionId });
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
      posthog.capture('session_reopened', { agent_id: agentId, session_id: sessionId });
      return true;
    } catch (cause) { reportError(cause); return false; }
  }, [agentId, sessions, store.loaded, saveInbox, reportError]);

  const snooze = useCallback(async (sessionId: string, durationSeconds?: number): Promise<boolean> => {
    return snoozeInStore(agentId, sessionId, durationSeconds);
  }, [agentId]);

  const unsnooze = useCallback(async (sessionId: string): Promise<boolean> => {
    return unsnoozeInStore(agentId, sessionId);
  }, [agentId]);

  /** Auto-settle opt-out: local immediately, then synced to the connector so paired devices agree. */
  const setAutoSettle = useCallback((sessionId: string, enabled: boolean) => {
    return toggleAutoSettle(agentId, sessionId, enabled, saveInbox);
  }, [agentId, saveInbox]);

  // Auto-settle: every minute, settle non-settled threads idle past the delay. Pinned/running/
  // pending-approval/disabled threads are skipped by isAutoSettleDue; settle re-checks eligibility.
  useEffect(() => {
    if (!store.loaded) return;
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      for (const session of sessions) {
        if (isAutoSettleDue(session, session.autoSettleDisabled, now)) void settle(session.id);
      }
    };
    tick();
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, [store.loaded, sessions, settle]);

  return { sessions, snoozed: store.snoozed, loaded: store.loaded, error: store.error, markRead, settle, reopen, snooze, unsnooze, setAutoSettle };
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
  useSnoozeExpiry(agentId, store.snoozed);
  return { snoozed: store.snoozed, loaded: store.loaded, snooze, unsnooze };
}

/** Toggle an auto-settle opt-out: local store first for instant UI, then the shared connector ledger. */
async function toggleAutoSettle(
  agentId: string,
  sessionId: string,
  enabled: boolean,
  saveInbox: (agentId: string, settled: InboxSettledState, importOnly?: boolean, config?: InboxConfig) => Promise<void>,
): Promise<boolean> {
  const entry = entryFor(agentId);
  if (!entry.loaded) return false;
  const next = { ...entry.autoSettleDisabled };
  if (enabled) delete next[sessionId];
  else next[sessionId] = true;
  await update(agentId, entry.settled, entry.read, entry.snoozed, next);
  try {
    await saveInbox(agentId, {}, false, { [sessionId]: { auto_settle: enabled } });
    return true;
  } catch (cause) {
    const failed = entryFor(agentId);
    failed.error = cause instanceof Error ? cause.message : 'Auto-settle could not be saved.';
    failed.snapshot = { ...failed.snapshot, error: failed.error };
    failed.listeners.forEach((listener) => listener());
    return false;
  }
}

/** Standalone access to the auto-settle opt-out ledger for views that receive sessions as props. */
export function useAutoSettleLedger(agentId: string): {
  loaded: boolean;
  setAutoSettle: (sessionId: string, enabled: boolean) => Promise<boolean>;
} {
  const { saveInbox } = useApollo();
  const store = useSyncExternalStore(
    useCallback((listener) => subscribe(agentId, listener), [agentId]),
    useCallback(() => snapshot(agentId), [agentId]),
    useCallback(() => SERVER_SNAPSHOT, []),
  );
  const setAutoSettle = useCallback((sessionId: string, enabled: boolean) => {
    return toggleAutoSettle(agentId, sessionId, enabled, saveInbox);
  }, [agentId, saveInbox]);
  return { loaded: store.loaded, setAutoSettle };
}
