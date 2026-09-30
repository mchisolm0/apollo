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

type Outbox = ReturnType<typeof createOutboxRuntime>;
type QueueInput = { id?: string; agentId: string; sessionId?: string; createsSession?: boolean; text: string; model?: string; instructions?: string; attachments: readonly DraftAttachment[] };
type OutboxContextValue = OutboxSnapshot & {
  enqueue(input: QueueInput): Promise<{ id: string; sessionId: string }>;
  retry(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  reload(): Promise<void>;
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
          await api.current.createSession(message.agentId, (message.text || message.attachments[0]?.name || 'New thread').slice(0, 72), message.sessionId);
          await checkpoint({ createsSession: false });
        }
        let attachments = message.attachments;
        for (const file of attachments) {
          if (file.uploaded) continue;
          available();
          const uploaded = await api.current.uploadAttachment(message.agentId, { name: file.name, mimeType: file.mimeType, data: await new File(file.uri).base64() });
          attachments = attachments.map((entry) => entry.id === file.id ? { ...entry, uploaded } : entry);
          await checkpoint({ attachments });
        }
        available();
        const run = await api.current.startRun(message.agentId, message.text, {
          sessionId: message.sessionId,
          idempotencyKey: message.id,
          model: message.model,
          instructions: message.instructions,
          attachments: attachments.flatMap((file) => file.uploaded ? [file.uploaded] : []),
        });
        await checkpoint({ acceptedRunId: run.runId });
        return run.runId;
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
    for (const agentId of removed) void outbox.forgetAgent(agentId).catch(() => {});
  }, [outbox, ekho.agents, ekho.loading, snapshot.loaded, snapshot.items]);

  const requireOutbox = () => {
    if (!outbox) throw new Error('The outbox is still loading. Try again.');
    return outbox;
  };
  return <OutboxContext.Provider value={{
    ...snapshot,
    enqueue: async ({ id, agentId, sessionId, createsSession, text, attachments, model, instructions }) => {
      const message = await requireOutbox().enqueue({
        id: id ?? randomUUID(), agentId, sessionId: sessionId ?? randomUUID(), createsSession: createsSession ?? !sessionId, text, attachments, model, instructions,
      });
      return { id: message.id, sessionId: message.sessionId };
    },
    retry: (id) => requireOutbox().retry(id),
    remove: (id) => requireOutbox().remove(id),
    reload: () => requireOutbox().load(),
  }}>{children}</OutboxContext.Provider>;
}

export function useOutbox() {
  const outbox = useContext(OutboxContext);
  if (!outbox) throw new Error('useOutbox must be used within OutboxProvider');
  return outbox;
}
