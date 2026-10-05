import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';

import { discardAttachment } from '../features/relay/pick-attachments';
import type { DraftAttachment } from './attachments';
import { useEkho } from './ekho-context';
import { createOutboxRuntime, type OutboxSnapshot } from './outbox';
import { isRunActive } from './run-state';
import { isJsonObject } from './protocol';

type Outbox = ReturnType<typeof createOutboxRuntime>;
type QueueInput = { id?: string; agentId: string; sessionId?: string; createsSession?: boolean; text: string; model?: string; provider?: string; instructions?: string; attachments: readonly DraftAttachment[] };
type OutboxContextValue = OutboxSnapshot & {
  enqueue(input: QueueInput): Promise<{ id: string; sessionId: string }>;
  retry(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  steer(id: string, runId: string): Promise<void>;
  reload(): Promise<void>;
  withReloadSafety(apply: () => Promise<boolean>): Promise<boolean>;
};

const EMPTY: OutboxSnapshot = { loaded: false, items: [] };
const emptySnapshot = () => EMPTY;
const noopSubscribe = () => () => {};
const OutboxContext = createContext<OutboxContextValue | null>(null);

export function OutboxProvider({ children }: PropsWithChildren) {
  const ekho = useEkho();
  const api = useRef(ekho);
  useLayoutEffect(() => { api.current = ekho; }, [ekho]);
  const [outbox, setOutbox] = useState<Outbox>();
  const snapshot = useSyncExternalStore(outbox?.subscribe ?? noopSubscribe, outbox?.getSnapshot ?? emptySnapshot, emptySnapshot);

  useEffect(() => {
    const queue = createOutboxRuntime({
      storage: AsyncStorage,
      referencedMessageIds: async () => {
        const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith('ekho.draft.v2.'));
        const drafts = await AsyncStorage.multiGet(keys);
        return drafts.flatMap(([, saved]) => {
          const record: unknown = saved === null ? null : JSON.parse(saved);
          if (record !== null && !isJsonObject(record)) throw new Error('Saved draft is invalid.');
          const prepared = isJsonObject(record) ? record.prepared : undefined;
          if (prepared === undefined) return [];
          if (!isJsonObject(prepared) || typeof prepared.id !== 'string') throw new Error('Saved draft identity is invalid.');
          return [prepared.id];
        });
      },
      canSend: (message) => {
        const { agents, runtime, loading } = api.current;
        const state = runtime[message.agentId];
        return !loading && AppState.currentState === 'active' && agents.some((agent) => agent.id === message.agentId)
          && state?.status === 'connected'
          && !Object.values(state.runs).some((run) => run.sessionId === message.sessionId && isRunActive(run.status));
      },
      deliver: async (message, checkpoint, signal) => {
        const available = () => {
          if (signal.aborted) throw new Error('Sending was interrupted. Try again.');
          if (!api.current.agents.some((agent) => agent.id === message.agentId)) throw Object.assign(new Error('This agent was removed.'), { status: 401 });
          if (AppState.currentState !== 'active') throw new Error('Waiting until Ekho is open to send.');
        };
        available();
        if (message.createsSession) {
          await api.current.createSession(message.agentId, (message.text || message.attachments[0]?.name || 'New thread').slice(0, 72), message.sessionId, signal);
          await checkpoint({ createsSession: false });
        }
        let attachments = message.attachments;
        for (const file of attachments) {
          if (file.uploaded) continue;
          available();
          const uploaded = await api.current.uploadAttachment(message.agentId, { name: file.name, mimeType: file.mimeType, data: await new File(file.uri).base64() }, signal);
          attachments = attachments.map((entry) => entry.id === file.id ? { ...entry, uploaded } : entry);
          await checkpoint({ attachments });
        }
        available();
        const run = await api.current.startRun(message.agentId, message.text, {
          sessionId: message.sessionId,
          signal,
          idempotencyKey: message.id,
          model: message.model,
          provider: message.provider,
          instructions: message.instructions,
          attachments: attachments.flatMap((file) => file.uploaded ? [file.uploaded] : []),
        });
        await checkpoint({ acceptedRunId: run.runId });
        return run.runId;
      },
      steer: (message, runId, signal) => {
        const run = api.current.runtime[message.agentId]?.runs[runId];
        if (!run || run.sessionId !== message.sessionId || !isRunActive(run.status) || run.status === 'stopping' || run.status === 'waiting_for_approval') throw Object.assign(new Error('The run is no longer accepting steer messages.'), { status: 409 });
        return api.current.steerRun(message.agentId, runId, message.text, signal);
      },
      discardAttachments: (attachments) => attachments.forEach(discardAttachment),
    });
    setOutbox(queue);
    queue.start();
    return () => { void queue.dispose(); };
  }, []);

  // Removed agents must not leave credentials-free, indefinitely waiting messages.
  useEffect(() => {
    if (!outbox || ekho.loading || !snapshot.loaded) return;
    const removed = new Set(snapshot.items.filter((item) => !ekho.agents.some((agent) => agent.id === item.agentId)).map((item) => item.agentId));
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = async () => {
      const results = await Promise.allSettled([...removed].map((agentId) => outbox.forgetAgent(agentId)));
      if (current && results.some((result) => result.status === 'rejected')) timer = setTimeout(() => void cleanup(), 5_000);
    };
    void cleanup();
    return () => { current = false; clearTimeout(timer); };
  }, [outbox, ekho.agents, ekho.loading, snapshot.loaded, snapshot.items]);

  const requireOutbox = () => {
    if (!outbox) throw new Error('The outbox is still loading. Try again.');
    return outbox;
  };
  return <OutboxContext.Provider value={{
    ...snapshot,
    enqueue: async ({ id, agentId, sessionId, createsSession, text, attachments, model, provider, instructions }) => {
      const message = await requireOutbox().enqueue({
        id: id ?? randomUUID(), agentId, sessionId: sessionId ?? randomUUID(), createsSession: createsSession ?? !sessionId, text, attachments, model, provider, instructions,
      });
      return { id: message.id, sessionId: message.sessionId };
    },
    retry: (id) => requireOutbox().retry(id),
    remove: (id) => requireOutbox().remove(id),
    steer: (id, runId) => requireOutbox().steer(id, runId),
    reload: () => requireOutbox().load(),
    withReloadSafety: (apply) => requireOutbox().withReloadSafety(apply),
  }}>{children}</OutboxContext.Provider>;
}

export function useOutbox() {
  const outbox = useContext(OutboxContext);
  if (!outbox) throw new Error('useOutbox must be used within OutboxProvider');
  return outbox;
}
