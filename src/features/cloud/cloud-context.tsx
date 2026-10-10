import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { AppState, Platform } from 'react-native';

import { allowsNotifications } from '@/features/notifications/notifications';
import { useApollo } from '@/lib/apollo-context';

import type { Card, CardResponse } from '../../../cloud/src/contract';
import { applyCard, applyStreamMessage, mergeSnapshot, parseCards, parseStreamMessage } from './cards';
import { CloudRequestError, createCloudClient, type CloudCredential } from './cloud-client';
import { CARD_CACHE_KEY, cloudCredentialStore, loadCloudCredential, saveCloudCredential } from './cloud-credentials';
import { ensureCloudChannels, respondQueue } from './cloud-runtime';
import { withPendingResponses, type InboxCard } from './inbox-rows';

/** off: no credential. live: stream open. offline: retrying. revoked: the token was rejected. */
export type CloudStatus = 'off' | 'connecting' | 'live' | 'offline' | 'revoked';

type CloudContextValue = {
  status: CloudStatus;
  credential?: CloudCredential;
  cards: readonly InboxCard[];
  /** False until the first snapshot or cached copy is in, so screens can tell "loading" from "gone". */
  ready: boolean;
  /** A response the server rejected. Connection trouble shows in `status` instead. */
  error?: string;
  dismissError(): void;
  respond(cardId: string, response: CardResponse): Promise<void>;
  /** Fetches a cloud token from this agent's connector and stores it. */
  connect(agentId: string): Promise<void>;
};

const PING_MS = 25_000;
const projectId = (Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId) as string | undefined;
// React Native's WebSocket takes headers as a third argument, which the DOM lib type omits.
const HeaderWebSocket: new (url: string, protocols: undefined, options: { headers: Record<string, string> }) => WebSocket = WebSocket;
const CloudContext = createContext<CloudContextValue | undefined>(undefined);

/**
 * Keeps the cloud inbox in sync while Apollo is in the foreground: a WebSocket for live
 * changes and a full snapshot on launch, foreground and every reconnect. Also registers
 * this phone for cloud push alongside (not instead of) each connector's own registration.
 */
export function CloudProvider({ children }: PropsWithChildren) {
  const { agents, runtime, cloudGrant } = useApollo();
  const { loaded, credential } = useSyncExternalStore(cloudCredentialStore.subscribe, cloudCredentialStore.getSnapshot);
  const queue = useSyncExternalStore(respondQueue.subscribe, respondQueue.getSnapshot);
  // Cards belong to the inbox they came from, so a new credential never shows another inbox's cards.
  const [inbox, setInbox] = useState<{ url: string; cards: readonly Card[]; ready: boolean }>();
  const [connection, setConnection] = useState<{ url: string; status: Exclude<CloudStatus, 'off' | 'connecting'> }>();
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [pushRevision, setPushRevision] = useState(0);
  const registered = useRef<string>(undefined);
  const granting = useRef(new Set<string>());

  const url = credential?.url;
  const setCards = useCallback((update: (current: readonly Card[]) => readonly Card[], ready?: boolean) => {
    if (!url) return;
    setInbox((current) => {
      const base = current?.url === url ? current : { url, cards: [], ready: false };
      return { url, cards: update(base.cards), ready: ready ?? base.ready };
    });
  }, [url]);

  useEffect(() => {
    void loadCloudCredential();
    void respondQueue.load();
    const appState = AppState.addEventListener('change', (next) => setActive(next === 'active'));
    const token = Platform.OS === 'web' ? undefined : Notifications.addPushTokenListener(() => {
      registered.current = undefined;
      setPushRevision((revision) => revision + 1);
    });
    return () => { appState.remove(); token?.remove(); };
  }, []);

  useEffect(() => respondQueue.onCard((card) => setCards((current) => applyCard(current, card))), [setCards]);

  // Cached cards keep the inbox from jumping while the first snapshot loads, and work offline.
  useEffect(() => {
    if (!url) return;
    let current = true;
    void AsyncStorage.getItem(CARD_CACHE_KEY).then((saved) => {
      if (!current || !saved) return;
      const value: unknown = JSON.parse(saved);
      if (!value || typeof value !== 'object' || !('url' in value) || value.url !== url || !('cards' in value)) return;
      const cached = parseCards(value.cards);
      setCards((local) => local.length ? local : cached, true);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [url, setCards]);

  useEffect(() => {
    if (inbox?.ready) void AsyncStorage.setItem(CARD_CACHE_KEY, JSON.stringify({ url: inbox.url, cards: inbox.cards })).catch(() => undefined);
  }, [inbox]);

  useEffect(() => {
    if (!credential || !active) return;
    const client = createCloudClient(credential);
    let closed = false;
    let revoked = false;
    let synced = false;
    let attempt = 0;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let lastHeard = Date.now();
    // Set while a snapshot is in flight, so a stream removal is not undone by a stale snapshot.
    let removedDuringSync: Set<string> | undefined;

    const sync = async () => {
      const removed = new Set<string>();
      removedDuringSync = removed;
      try {
        const snapshot = await client.cards();
        if (closed) return;
        synced = true;
        setCards((local) => mergeSnapshot(local, snapshot, removed), true);
        void respondQueue.flush();
      } catch (cause) {
        if (closed) return;
        if (cause instanceof CloudRequestError && (cause.status === 401 || cause.status === 403)) {
          revoked = true;
          setConnection({ url: credential.url, status: 'revoked' });
          socket?.close();
        }
      } finally {
        if (removedDuringSync === removed) removedDuringSync = undefined;
      }
    };
    // Stream first, then the snapshot (docs/cloud-inbox.md, Reconciling).
    const open = () => {
      if (closed || revoked) return;
      const next = new HeaderWebSocket(client.streamUrl(), undefined, { headers: { Authorization: `Bearer ${credential.token}` } });
      socket = next;
      next.onopen = () => {
        attempt = 0;
        lastHeard = Date.now();
        setConnection({ url: credential.url, status: 'live' });
        void sync();
        ping = setInterval(() => {
          // Two missed pongs: the socket is dead even if the OS has not noticed.
          if (Date.now() - lastHeard > PING_MS * 2) next.close();
          else next.send('ping');
        }, PING_MS);
      };
      next.onmessage = (event) => {
        lastHeard = Date.now();
        const message = parseStreamMessage(event.data);
        if (!message) return;
        if (message.type === 'remove') removedDuringSync?.add(message.id);
        setCards((local) => applyStreamMessage(local, message));
      };
      next.onclose = () => {
        clearInterval(ping);
        if (closed || socket !== next) return;
        if (!revoked) setConnection({ url: credential.url, status: 'offline' });
        // Without a stream, still show what the server has.
        if (!synced) void sync();
        retry = setTimeout(open, Math.min(1000 * 2 ** attempt++, 30_000));
      };
    };
    open();
    // A handshake that hangs should not leave the inbox empty until the OS gives up on it.
    const fallback = setTimeout(() => { if (!synced) void sync(); }, 5_000);
    return () => {
      closed = true;
      setConnection(undefined);
      clearTimeout(fallback);
      clearTimeout(retry);
      clearInterval(ping);
      socket?.close();
    };
  }, [credential, active, setCards]);

  // Retry queued responses when their backoff ends.
  const nextAttemptAt = respondQueue.nextAttemptAt();
  useEffect(() => {
    if (!credential || !active) return;
    if (nextAttemptAt === undefined) { void respondQueue.flush(); return; }
    const timer = setTimeout(() => void respondQueue.flush(), Math.max(0, nextAttemptAt - Date.now()));
    return () => clearTimeout(timer);
  }, [credential, active, nextAttemptAt]);

  // Cloud push registration. Never prompts: permission comes from the notification settings screen.
  useEffect(() => {
    if (!credential || !active || !projectId || Platform.OS === 'web') return;
    void (async () => {
      if (!allowsNotifications(await Notifications.getPermissionsAsync())) return;
      await ensureCloudChannels();
      const expoPushToken = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      const key = JSON.stringify([credential.url, credential.agentId, expoPushToken]);
      if (registered.current === key) return;
      await createCloudClient(credential).registerDevice({ expoPushToken, platform: Platform.OS === 'ios' ? 'ios' : 'android', ...(Device.deviceName ? { name: Device.deviceName } : {}) });
      registered.current = key;
    })().catch(() => undefined);
  }, [credential, active, pushRevision]);

  // Phones paired before the cloud inbox existed ask a connected agent for a token once per launch.
  useEffect(() => {
    if (!loaded || credential) return;
    const agent = agents.find((candidate) => runtime[candidate.id]?.status === 'connected' && !granting.current.has(candidate.id));
    if (!agent) return;
    granting.current.add(agent.id);
    void cloudGrant(agent.id).then((grant) => grant ? saveCloudCredential({ ...grant, agentId: agent.id }) : undefined).catch(() => undefined);
  }, [loaded, credential, agents, runtime, cloudGrant]);

  const respond = useCallback(async (cardId: string, response: CardResponse) => {
    respondQueue.clearError();
    await respondQueue.enqueue({ key: randomUUID(), cardId, response });
    void respondQueue.flush();
  }, []);

  const connect = useCallback(async (agentId: string) => {
    const grant = await cloudGrant(agentId);
    if (!grant) throw new Error('This agent has no cloud inbox configured.');
    await saveCloudCredential({ ...grant, agentId });
  }, [cloudGrant]);

  const current = url && inbox?.url === url ? inbox : undefined;
  const inboxCards = useMemo(() => withPendingResponses(current?.cards ?? [], queue.items), [current, queue.items]);
  const status: CloudStatus = !credential ? 'off' : connection?.url === credential.url ? connection.status : 'connecting';
  const value = useMemo<CloudContextValue>(() => ({
    status,
    credential,
    cards: inboxCards,
    ready: current?.ready ?? false,
    error: queue.error,
    dismissError: respondQueue.clearError,
    respond,
    connect,
  }), [credential, status, inboxCards, current, queue.error, respond, connect]);
  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}

export function useCloud(): CloudContextValue {
  const value = useContext(CloudContext);
  if (!value) throw new Error('useCloud must be used inside CloudProvider');
  return value;
}
