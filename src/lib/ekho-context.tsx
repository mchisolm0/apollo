import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { AppState } from 'react-native';

import { AgentCatalog } from './catalog';
import { eventTransportIdentity, isRunActive, statusAfterEvent } from './run-state';
import { PairingClient, parsePairingLink } from './pairing';
import { HermesClient, HermesRequestError, type RunEventSubscription } from './hermes-client';
import type {
  AgentRecord,
  AgentRuntimeState,
  AgentTransport,
  ApprovalOptions,
  HermesApprovalResponse,
  HermesMessage,
  HermesRunEvent,
  HermesRunStatus,
  StartRunOptions,
} from './types';

export interface EkhoContextValue {
  agents: readonly AgentRecord[];
  runtime: Readonly<Record<string, AgentRuntimeState>>;
  messages: Readonly<Record<string, readonly HermesMessage[]>>;
  loading: boolean;
  error?: string;
  pair(link: string, deviceName?: string): Promise<AgentRecord>;
  refreshAgent(agentId: string): Promise<void>;
  retryAgent(agentId: string): Promise<void>;
  startRun(agentId: string, input: string, options?: StartRunOptions): Promise<HermesRunStatus>;
  createSession(agentId: string, title?: string): Promise<string>;
  sessionMessages(agentId: string, sessionId: string): Promise<readonly HermesMessage[]>;
  stopRun(agentId: string, runId?: string): Promise<HermesRunStatus>;
  approveRun(
    agentId: string,
    runId: string,
    choice: 'once' | 'session' | 'always' | 'deny',
    options?: ApprovalOptions,
  ): Promise<HermesApprovalResponse>;
  removeAgent(agentId: string): Promise<void>;
}

const EkhoContext = createContext<EkhoContextValue | undefined>(undefined);

function emptyRuntime(): AgentRuntimeState {
  return { status: 'idle', sessions: [], events: [] };
}

function transportFor(endpoint: string): AgentTransport {
  const url = new URL(endpoint);
  if (url.hostname.endsWith('.ts.net')) return 'tailscale';
  return url.protocol === 'http:' ? 'lan' : 'https';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Connection failed';
}

export function EkhoProvider({
  children,
  catalog: suppliedCatalog,
  pairingClient: suppliedPairingClient,
}: PropsWithChildren<{ catalog?: AgentCatalog; pairingClient?: PairingClient }>) {
  const catalog = useMemo(() => suppliedCatalog ?? new AgentCatalog(), [suppliedCatalog]);
  const pairingClient = useMemo(() => suppliedPairingClient ?? new PairingClient(), [suppliedPairingClient]);
  const [agents, setAgents] = useState<readonly AgentRecord[]>([]);
  const [runtime, setRuntime] = useState<Record<string, AgentRuntimeState>>({});
  const [messages, setMessages] = useState<Record<string, readonly HermesMessage[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const startingRuns = useRef(new Set<string>());
  const clients = useRef(new Map<string, HermesClient>());
  const subscriptions = useRef(new Map<string, RunEventSubscription & { runId: string }>());

  const updateRuntime = useCallback((agentId: string, patch: Partial<AgentRuntimeState>) => {
    setRuntime((current) => ({
      ...current,
      [agentId]: { ...(current[agentId] ?? emptyRuntime()), ...patch },
    }));
  }, []);

  const closeSubscription = useCallback((agentId: string) => {
    subscriptions.current.get(agentId)?.close();
    subscriptions.current.delete(agentId);
  }, []);

  const subscribe = useCallback((agent: AgentRecord, client: HermesClient, runId: string) => {
    if (subscriptions.current.get(agent.id)?.runId === runId) return;
    closeSubscription(agent.id);
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let pollDelay = 3_000;
    let closed = false;
    let pending: HermesRunEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Hermes timestamps each event; replayed events must not duplicate streamed text.
    const seen = new Set<string>();
    const flush = () => {
      timer = undefined;
      if (closed || !pending.length) return;
      const batch = pending;
      pending = [];
      setRuntime((current) => {
        const existing = current[agent.id];
        if (!existing || existing.activeRun?.runId !== runId) return current;
        const events = [...existing.events, ...batch];
        const activeRun = batch.reduce(statusAfterEvent, existing.activeRun);
        return { ...current, [agent.id]: { ...existing, status: 'connected', events, activeRun } };
      });
    };
    const source = client.subscribeRunEvents(runId, {
      onEvent: (event) => {
        if (closed) return;
        const identity = eventTransportIdentity(event);
        if (identity && seen.has(identity)) return;
        if (identity) seen.add(identity);
        pending.push(event);
        if (!timer) timer = setTimeout(flush, 50);
        if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.event)) {
          if (timer) clearTimeout(timer);
          flush();
          void client.runStatus(runId).then(async (status) => {
            if (closed) return;
            updateRuntime(agent.id, { activeRun: status });
            if (!isRunActive(status.status)) {
              const [sessions, history] = await Promise.all([
                client.sessions(),
                status.sessionId ? client.sessionMessages(status.sessionId) : Promise.resolve(undefined),
              ]);
              if (closed) return;
              updateRuntime(agent.id, { sessions });
              if (history && status.sessionId) setMessages((current) => ({ ...current, [`${agent.id}:${status.sessionId}`]: history }));
              closeSubscription(agent.id);
            }
          }).catch(() => undefined);
        }
      },
      onError: (streamError) => {
        if (closed) return;
        if (timer) clearTimeout(timer);
        flush();
        updateRuntime(agent.id, { status: 'offline', error: streamError.message });
        // Hermes can expire a consumed SSE stream. Recover from durable status/history.
        const reconcile = async () => {
          if (polling || closed) return;
          polling = true;
          try {
            const status = await client.runStatus(runId);
            const history = status.sessionId ? await client.sessionMessages(status.sessionId) : undefined;
            if (closed) return;
            pollDelay = 3_000;
            updateRuntime(agent.id, { status: 'connected', activeRun: status, error: undefined });
            if (history && status.sessionId) setMessages((current) => ({ ...current, [`${agent.id}:${status.sessionId}`]: history }));
            if (!isRunActive(status.status)) closeSubscription(agent.id);
          } catch (error) {
            if (!closed) {
              const revoked = error instanceof HermesRequestError && error.status === 401;
              updateRuntime(agent.id, { status: revoked ? 'revoked' : 'offline', error: errorText(error) });
              if (revoked) closeSubscription(agent.id);
              else pollDelay = Math.min(pollDelay * 2, 30_000);
            }
          } finally {
            polling = false;
            if (!closed) pollTimer = setTimeout(() => void reconcile(), pollDelay);
          }
        };
        if (!pollTimer && !polling) void reconcile();
      },
    });
    subscriptions.current.set(agent.id, { runId, close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
      source.close();
    } });
  }, [closeSubscription, updateRuntime]);

  const refreshAgent = useCallback(async (agentId: string): Promise<void> => {
    const agent = catalog.get(agentId);
    // Fast Refresh can preserve view state while recreating the catalog.
    if (!agent) return;
    const token = await catalog.credentials.get(agentId);
    if (!token) {
      updateRuntime(agentId, { status: 'offline', error: 'This agent has no saved credential' });
      return;
    }
    updateRuntime(agentId, { status: 'connecting', error: undefined });
    try {
      const client = new HermesClient({ endpoint: agent.endpoint.url, token });
      clients.current.set(agentId, client);
      const [capabilities, sessions] = await Promise.all([client.capabilities(), client.sessions()]);
      let activeRun: HermesRunStatus | undefined;
      if (agent.activeRunId) {
        try { activeRun = await client.runStatus(agent.activeRunId); }
        catch (error) {
          // An expired run should not make a reachable agent look offline.
          if (!(error instanceof HermesRequestError) || error.status !== 404) throw error;
        }
      }
      const updated = await catalog.update(agentId, {
        lastConnectedAt: Date.now(),
        capabilities,
        activeRunId: activeRun?.runId,
      });
      setAgents(catalog.list());
      if (activeRun?.sessionId) {
        const history = await client.sessionMessages(activeRun.sessionId);
        setMessages((current) => ({ ...current, [`${agentId}:${activeRun.sessionId}`]: history }));
      }
      setRuntime((current) => ({ ...current, [agentId]: { ...current[agentId], status: 'connected', capabilities, sessions, activeRun, events: current[agentId]?.activeRun?.runId === activeRun?.runId ? current[agentId]?.events ?? [] : [], error: undefined } }));
      if (activeRun && isRunActive(activeRun.status)) subscribe(updated, client, activeRun.runId);
      else closeSubscription(agentId);
    } catch (connectionError) {
      clients.current.delete(agentId);
      closeSubscription(agentId);
      updateRuntime(agentId, {
        status: connectionError instanceof HermesRequestError && connectionError.status === 401 ? 'revoked' : 'offline',
        error: errorText(connectionError),
      });
    }
  }, [catalog, closeSubscription, subscribe, updateRuntime]);

  useEffect(() => {
    let cancelled = false;
    const activeSubscriptions = subscriptions.current;
    void catalog.load().then((loadedAgents) => {
      if (cancelled) return;
      setAgents(loadedAgents);
      setLoading(false);
      void Promise.all(loadedAgents.map((agent) => refreshAgent(agent.id)));
    }).catch((loadError) => {
      if (!cancelled) {
        setError(errorText(loadError));
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
      for (const subscription of activeSubscriptions.values()) subscription.close();
      activeSubscriptions.clear();
    };
  }, [catalog, refreshAgent]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void Promise.all(catalog.list().map((agent) => refreshAgent(agent.id)));
    });
    return () => subscription.remove();
  }, [catalog, refreshAgent]);

  const pair = useCallback(async (link: string, deviceName?: string): Promise<AgentRecord> => {
    try {
      const input = parsePairingLink(link);
      const result = await pairingClient.exchange(input.endpoint, input.bootstrapToken, deviceName);
      const agent: AgentRecord = {
        id: result.descriptor.id,
        label: result.descriptor.label,
        hostname: result.descriptor.hostname,
        endpoint: { url: input.endpoint, transport: transportFor(input.endpoint) },
        createdAt: Date.now(),
        capabilities: result.descriptor.capabilities,
      };
      await catalog.upsert(agent, result.accessToken);
      setAgents(catalog.list());
      updateRuntime(agent.id, { status: 'idle', capabilities: result.descriptor.capabilities });
      await refreshAgent(agent.id);
      return catalog.get(agent.id) ?? agent;
    } catch (pairingError) {
      setError(errorText(pairingError));
      throw pairingError;
    }
  }, [catalog, pairingClient, refreshAgent, updateRuntime]);

  const startRun = useCallback(async (agentId: string, input: string, options?: StartRunOptions): Promise<HermesRunStatus> => {
    if (startingRuns.current.has(agentId) || isRunActive(runtime[agentId]?.activeRun?.status)) {
      throw new Error('Finish or stop the current run before starting another thread.');
    }
    startingRuns.current.add(agentId);
    try {
      const agent = catalog.get(agentId);
      if (!agent) throw new Error(`Unknown agent: ${agentId}`);
      let client = clients.current.get(agentId);
      if (!client) {
        await refreshAgent(agentId);
        client = clients.current.get(agentId);
      }
      if (!client) throw new Error('Agent is offline');
      const result = await client.startRun(input, options);
      const status = { ...result, sessionId: result.sessionId ?? options?.sessionId };
      await catalog.update(agentId, { activeRunId: status.runId });
      setAgents(catalog.list());
      updateRuntime(agentId, { status: 'connected', activeRun: status, events: [] });
      if (status.sessionId) {
        const key = `${agentId}:${status.sessionId}`;
        setMessages((current) => ({ ...current, [key]: [...(current[key] ?? []), { id: `run-user-${status.runId}`, role: 'user', content: input, timestamp: status.createdAt }] }));
      }
      subscribe(agent, client, status.runId);
      return status;
    } finally { startingRuns.current.delete(agentId); }
  }, [catalog, refreshAgent, runtime, subscribe, updateRuntime]);

  const stopRun = useCallback(async (agentId: string, runId?: string): Promise<HermesRunStatus> => {
    const client = clients.current.get(agentId);
    const activeRunId = runId ?? runtime[agentId]?.activeRun?.runId ?? catalog.get(agentId)?.activeRunId;
    if (!client || !activeRunId) throw new Error('No active run');
    const status = await client.stopRun(activeRunId);
    updateRuntime(agentId, { activeRun: status });
    return status;
  }, [catalog, runtime, updateRuntime]);

  const createSession = useCallback(async (agentId: string, title?: string): Promise<string> => {
    let client = clients.current.get(agentId);
    if (!client) {
      await refreshAgent(agentId);
      client = clients.current.get(agentId);
    }
    if (!client) throw new Error('Agent is offline');
    const session = await client.createSession(title ? { title } : {});
    updateRuntime(agentId, { sessions: [session, ...(runtime[agentId]?.sessions ?? [])] });
    return session.id;
  }, [refreshAgent, runtime, updateRuntime]);

  const sessionMessages = useCallback(async (agentId: string, sessionId: string): Promise<readonly HermesMessage[]> => {
    let client = clients.current.get(agentId);
    if (!client) {
      await refreshAgent(agentId);
      client = clients.current.get(agentId);
    }
    if (!client) throw new Error('Agent is offline');
    const loaded = await client.sessionMessages(sessionId);
    setMessages((current) => ({ ...current, [`${agentId}:${sessionId}`]: loaded }));
    return loaded;
  }, [refreshAgent]);

  const approveRun = useCallback(async (
    agentId: string,
    runId: string,
    choice: 'once' | 'session' | 'always' | 'deny',
    options?: ApprovalOptions,
  ): Promise<HermesApprovalResponse> => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Agent is offline');
    const result = await client.approveRun(runId, choice, options);
    const status = await client.runStatus(runId);
    setRuntime((current) => {
      const existing = current[agentId];
      if (!existing || existing.activeRun?.runId !== runId) return current;
      return { ...current, [agentId]: { ...existing, activeRun: status, events: [...existing.events, { event: 'approval.responded', runId }] } };
    });
    return result;
  }, []);

  const retryAgent = useCallback((agentId: string) => refreshAgent(agentId), [refreshAgent]);

  const removeAgent = useCallback(async (agentId: string) => {
    closeSubscription(agentId);
    clients.current.delete(agentId);
    await catalog.remove(agentId);
    setAgents(catalog.list());
    setRuntime((current) => {
      const next = { ...current };
      delete next[agentId];
      return next;
    });
    setMessages((current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) if (key.startsWith(`${agentId}:`)) delete next[key];
      return next;
    });
  }, [catalog, closeSubscription]);

  const value = useMemo<EkhoContextValue>(() => ({
    agents,
    runtime,
    messages,
    loading,
    error,
    pair,
    refreshAgent,
    retryAgent,
    startRun,
    createSession,
    sessionMessages,
    stopRun,
    approveRun,
    removeAgent,
  }), [agents, approveRun, createSession, error, loading, messages, pair, refreshAgent, removeAgent, retryAgent, runtime, sessionMessages, startRun, stopRun]);

  return <EkhoContext.Provider value={value}>{children}</EkhoContext.Provider>;
}

export function useEkho(): EkhoContextValue {
  const value = useContext(EkhoContext);
  if (!value) throw new Error('useEkho must be used inside EkhoProvider');
  return value;
}
