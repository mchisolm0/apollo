import { posthog } from '@/config/posthog';
import { createNotificationRegistrationClient, type NotificationRegistrationClient } from '@/features/notifications/notifications';
import { attachmentMessage, type Attachment, type AttachmentSource } from './attachments';
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

import { reconcileHistory } from './message-history';
import { AgentCatalog } from './catalog';
import { eventTransportIdentity, isRunActive, statusAfterEvent } from './run-state';
import { PairingClient, parsePairingLink } from './pairing';
import { HermesClient, HermesRequestError, type RunEventSubscription } from './hermes-client';
import type {
  AgentRecord,
  InboxConfig,
  InboxSettledState,
  AgentRuntimeState,
  AgentTransport,
  ApprovalOptions,
  HermesApprovalResponse,
  HermesMessage,
  HermesModel,
  HermesModelLock,
  HermesToolset,
  HermesSession,
  HermesRunEvent,
  HermesRunStatus,
  HermesSkill,
  StartRunOptions,
} from './types';

export interface EkhoContextValue {
  agents: readonly AgentRecord[];
  runtime: Readonly<Record<string, AgentRuntimeState>>;
  messages: Readonly<Record<string, readonly HermesMessage[]>>;
  loading: boolean;
  error?: string;
  pair(link: string, deviceName?: string): Promise<AgentRecord>;
  saveInbox(agentId: string, settled: InboxSettledState, importOnly?: boolean, config?: InboxConfig): Promise<void>;
  refreshAgent(agentId: string): Promise<void>;
  retryAgent(agentId: string): Promise<void>;
  startRun(agentId: string, input: string, options?: StartRunOptions): Promise<HermesRunStatus>;
  createSession(agentId: string, title?: string, sessionId?: string, signal?: AbortSignal): Promise<string>;
  deleteSession(agentId: string, sessionId: string): Promise<void>;
  setPinned(agentId: string, sessionId: string, pinned: boolean): Promise<void>;
  forkSession(agentId: string, sessionId: string): Promise<string>;
  regenerateTitle(agentId: string, sessionId: string, input: string): Promise<string | undefined>;
  models(agentId: string): Promise<readonly HermesModel[]>;
  toolsets(agentId: string): Promise<readonly HermesToolset[]>;
  sessionDetail(agentId: string, sessionId: string): Promise<HermesSession>;
  setSessionModel(agentId: string, sessionId: string, model: HermesModel): Promise<HermesModelLock>;
  steerRun(agentId: string, runId: string, input: string): Promise<void>;
  uploadAttachment(agentId: string, file: { name: string; mimeType: string; data: string }, signal?: AbortSignal): Promise<Attachment>;
  attachmentSource(agentId: string, id: string): AttachmentSource | undefined;
  sessionMessages(agentId: string, sessionId: string): Promise<readonly HermesMessage[]>;
  skills(agentId: string): Promise<readonly HermesSkill[]>;
  stopRun(agentId: string, runId: string): Promise<HermesRunStatus>;
  approveRun(
    agentId: string,
    runId: string,
    choice: 'once' | 'session' | 'always' | 'deny',
    options?: ApprovalOptions,
  ): Promise<HermesApprovalResponse>;
  removeAgent(agentId: string): Promise<void>;
  hasSession(agentId: string, sessionId: string): boolean;
  notificationClient(agentId: string): Promise<NotificationRegistrationClient>;
}

// Several missed keepalives: long enough that a quiet but healthy run rarely pays for a status request.
const QUIET_STREAM_MS = 45_000;

const EkhoContext = createContext<EkhoContextValue | undefined>(undefined);

function emptyRuntime(): AgentRuntimeState {
  return { status: 'idle', sessions: [], runs: {}, events: [] };
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
  const [runtime, publishRuntime] = useState<Record<string, AgentRuntimeState>>({});
  const runtimeRef = useRef(runtime);
  const setRuntime = useCallback((update: (current: Record<string, AgentRuntimeState>) => Record<string, AgentRuntimeState>) => {
    runtimeRef.current = update(runtimeRef.current);
    publishRuntime(runtimeRef.current);
  }, []);
  const [messages, setMessages] = useState<Record<string, readonly HermesMessage[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const startingRuns = useRef(new Set<string>());
  const newSessions = useRef(new Set<string>());
  const clients = useRef(new Map<string, HermesClient>());
  const subscriptions = useRef(new Map<string, RunEventSubscription & { runId: string }>());

  const updateRuntime = useCallback((agentId: string, patch: Partial<AgentRuntimeState>) => {
    setRuntime((current) => ({
      ...current,
      [agentId]: { ...(current[agentId] ?? emptyRuntime()), ...patch },
    }));
  }, [setRuntime]);

  const closeSubscription = useCallback((agentId: string, runId?: string) => {
    for (const [key, subscription] of subscriptions.current) {
      if (key === JSON.stringify([agentId, subscription.runId]) && (!runId || subscription.runId === runId)) {
        subscription.close();
        subscriptions.current.delete(key);
      }
    }
  }, []);

  const updateRun = useCallback((agentId: string, run: HermesRunStatus) => {
    setRuntime((current) => {
      const existing = current[agentId] ?? emptyRuntime();
      return { ...current, [agentId]: { ...existing, runs: { ...existing.runs, [run.runId]: run } } };
    });
  }, [setRuntime]);

  const subscribe = useCallback((agent: AgentRecord, client: HermesClient, runId: string) => {
    const key = JSON.stringify([agent.id, runId]);
    if (subscriptions.current.has(key)) return;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let recovering = false;
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
        if (!existing || !existing.runs[runId]) return current;
        const events = [...existing.events, ...batch];
        const activeRun = batch.reduce(statusAfterEvent, existing.runs[runId]);
        return { ...current, [agent.id]: { ...existing, status: 'connected', events, runs: { ...existing.runs, [runId]: activeRun } } };
      });
    };
    // The stream failed or went stale: stop listening and reconcile from durable status and history.
    const recover = (streamError: Error) => {
      if (closed || recovering) return;
      recovering = true;
      // Hermes consumes and removes disconnected streams. Recover by polling.
      source.close();
      if (timer) clearTimeout(timer);
      if (quietTimer) clearTimeout(quietTimer);
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
          updateRuntime(agent.id, { status: 'connected', error: undefined });
          updateRun(agent.id, status);
          if (history && status.sessionId) setMessages((current) => ({ ...current, [`${agent.id}:${status.sessionId}`]: reconcileHistory(current[`${agent.id}:${status.sessionId}`] ?? [], history) }));
          if (!isRunActive(status.status)) closeSubscription(agent.id, runId);
        } catch (error) {
          if (!closed) {
            const revoked = error instanceof HermesRequestError && error.status === 401;
            updateRuntime(agent.id, { status: revoked ? 'revoked' : 'offline', error: errorText(error) });
            if (revoked) closeSubscription(agent.id, runId);
            else pollDelay = Math.min(pollDelay * 2, 30_000);
          }
        } finally {
          polling = false;
          if (!closed) pollTimer = setTimeout(() => void reconcile(), pollDelay);
        }
      };
      if (!pollTimer && !polling) void reconcile();
    };
    // react-native-sse drops Hermes's 10s keepalive comments, so silence alone
    // cannot prove the stream died. After a quiet stretch, ask for the run status:
    // an unreachable agent or an already-finished run means the stream is stale.
    const checkQuiet = async () => {
      if (closed || recovering) return;
      try {
        const status = await client.runStatus(runId);
        if (closed || recovering) return;
        if (isRunActive(status.status)) {
          updateRun(agent.id, status);
          armQuietCheck();
          return;
        }
        recover(new Error('Hermes event stream went quiet'));
      } catch (error) {
        if (!closed) recover(error instanceof Error ? error : new Error('Hermes event stream went quiet'));
      }
    };
    const armQuietCheck = () => {
      if (recovering) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => void checkQuiet(), QUIET_STREAM_MS);
    };
    const source = client.subscribeRunEvents(runId, {
      onEvent: (event) => {
        if (closed) return;
        const identity = eventTransportIdentity(event);
        if (identity && seen.has(identity)) return;
        if (identity) seen.add(identity);
        pending.push({ ...event, runId });
        armQuietCheck();
        if (!timer) timer = setTimeout(flush, 50);
        if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.event)) {
          if (timer) clearTimeout(timer);
          flush();
          void client.runStatus(runId).then(async (status) => {
            if (closed) return;
            updateRun(agent.id, status);
            if (!isRunActive(status.status)) {
              const [sessions, history] = await Promise.all([
                client.sessions(),
                status.sessionId ? client.sessionMessages(status.sessionId) : Promise.resolve(undefined),
              ]);
              if (closed) return;
              updateRuntime(agent.id, { sessions });
              if (history && status.sessionId) setMessages((current) => ({ ...current, [`${agent.id}:${status.sessionId}`]: reconcileHistory(current[`${agent.id}:${status.sessionId}`] ?? [], history) }));
              closeSubscription(agent.id, runId);
              // The final response may commit moments after the terminal event;
              // incomplete history gets one retry before the next refresh picks it up.
              if (history?.at(-1)?.role === 'tool') {
                setTimeout(() => {
                  // The subscription is already closed here, so `closed` is always true.
                  void client.sessionMessages(status.sessionId!).then((retry) => {
                    setMessages((current) => ({ ...current, [`${agent.id}:${status.sessionId}`]: reconcileHistory(current[`${agent.id}:${status.sessionId}`] ?? [], retry) }));
                  }).catch(() => undefined);
                }, 2_000);
              }
            }
          }).catch(() => undefined);
        }
      },
      onError: recover,
    });
    armQuietCheck();
    subscriptions.current.set(key, { runId, close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
      if (quietTimer) clearTimeout(quietTimer);
      source.close();
    } });
  }, [closeSubscription, updateRuntime, updateRun, setRuntime]);

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
      const beforeRefresh = runtimeRef.current[agentId]?.runs;
      const restored = await Promise.all((agent.activeRunIds ?? []).map(async (runId) => {
        try { return await client.runStatus(runId); }
        catch (error) {
          if (!(error instanceof HermesRequestError) || error.status !== 404) throw error;
          return undefined;
        }
      }));
      const runs = restored.filter((run): run is HermesRunStatus => run !== undefined);
      const updated = await catalog.update(agentId, { lastConnectedAt: Date.now(), capabilities });
      setAgents(catalog.list());
      updateRuntime(agentId, { status: 'connected', capabilities, sessions, error: undefined });
      for (const run of runs) {
        if (runtimeRef.current[agentId]?.runs[run.runId] !== beforeRefresh?.[run.runId]) continue;
        updateRun(agentId, run);
        if (run.sessionId) {
          const history = await client.sessionMessages(run.sessionId);
          setMessages((current) => ({ ...current, [`${agentId}:${run.sessionId}`]: reconcileHistory(current[`${agentId}:${run.sessionId}`] ?? [], history) }));
        }
        if (isRunActive(run.status)) subscribe(updated, client, run.runId);
        else closeSubscription(agentId, run.runId);
      }
    } catch (connectionError) {
      clients.current.delete(agentId);
      closeSubscription(agentId);
      updateRuntime(agentId, {
        status: connectionError instanceof HermesRequestError && connectionError.status === 401 ? 'revoked' : 'offline',
        error: errorText(connectionError),
      });
    }
  }, [catalog, closeSubscription, subscribe, updateRuntime, updateRun]);

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
      posthog.capture('agent_paired', {
        agent_id: agent.id,
        transport: agent.endpoint.transport,
        platform: result.descriptor.capabilities?.platform ?? null,
      });
      return catalog.get(agent.id) ?? agent;
    } catch (pairingError) {
      setError(errorText(pairingError));
      throw pairingError;
    }
  }, [catalog, pairingClient, refreshAgent, updateRuntime]);

  const updateSessionModel = useCallback((agentId: string, sessionId: string, model: string) => {
    setRuntime((current) => {
      const state = current[agentId];
      return state ? { ...current, [agentId]: { ...state, sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, model } : session) } } : current;
    });
  }, [setRuntime]);

  const setSessionModel = useCallback(async (agentId: string, sessionId: string, model: HermesModel) => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Reconnect to change the thread model.');
    const lock = await client.setSessionModel(sessionId, model);
    updateSessionModel(agentId, sessionId, lock.model);
    return lock;
  }, [updateSessionModel]);

  const startRun = useCallback(async (agentId: string, input: string, options?: StartRunOptions): Promise<HermesRunStatus> => {
    const key = JSON.stringify([agentId, options?.sessionId]);
    if (startingRuns.current.has(key) || (options?.sessionId && Object.values(runtimeRef.current[agentId]?.runs ?? {}).some((run) => run.sessionId === options.sessionId && isRunActive(run.status)))) {
      throw new Error('Finish or stop the current run in this thread before sending another message.');
    }
    startingRuns.current.add(key);
    try {
      const agent = catalog.get(agentId);
      if (!agent) throw new Error(`Unknown agent: ${agentId}`);
      let client = clients.current.get(agentId);
      if (!client) {
        await refreshAgent(agentId);
        client = clients.current.get(agentId);
      }
      if (!client) throw new Error('Agent is offline');
      let runOptions = options;
      const gatewayDefault = options?.provider === 'hermes' && options.model === agent.capabilities?.model;
      if (gatewayDefault) runOptions = { ...options, model: undefined, provider: undefined };
      else if (options?.sessionId && options.model) {
        const lock = await client.setSessionModel(options.sessionId, { id: options.model, provider: options.provider }, options.signal);
        updateSessionModel(agentId, options.sessionId, lock.model);
        runOptions = { ...options, model: undefined, provider: undefined };
      }
      const result = await client.startRun(input, runOptions);
      const status = { ...result, sessionId: result.sessionId ?? options?.sessionId };
      const previousRuns = runtimeRef.current[agentId]?.runs ?? {};
      updateRun(agentId, status);
      updateRuntime(agentId, { status: 'connected' });
      if (status.sessionId) {
        const key = `${agentId}:${status.sessionId}`;
        setMessages((current) => current[key]?.some((message) => message.id === `run-user-${status.runId}`) ? current : ({ ...current, [key]: [...(current[key] ?? []), { id: `run-user-${status.runId}`, role: 'user', content: attachmentMessage(input, options?.attachments), timestamp: status.createdAt }] }));
      }
      subscribe(agent, client, status.runId);
      if (status.sessionId && newSessions.current.delete(`${agentId}:${status.sessionId}`)) {
        const sessionId = status.sessionId;
        void client.generateSessionTitle(sessionId, input || options?.attachments?.map((file) => file.name).join(', ') || 'Attached files').then((title) => {
          if (title) setRuntime((current) => {
            const state = current[agentId];
            return state ? { ...current, [agentId]: { ...state, sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, title } : session) } } : current;
          });
        }).catch(() => undefined);
      }
      await catalog.update(agentId, { activeRunIds: [...new Set([
        ...(catalog.get(agentId)?.activeRunIds ?? []).filter((id) => !status.sessionId || previousRuns[id]?.sessionId !== status.sessionId),
        status.runId,
      ])] });
      setAgents(catalog.list());
      posthog.capture('run_started', {
        agent_id: agentId,
        run_id: status.runId,
        session_id: status.sessionId ?? null,
        has_attachments: (options?.attachments?.length ?? 0) > 0,
      });
      return status;
    } finally { startingRuns.current.delete(key); }
  }, [catalog, refreshAgent, subscribe, updateRuntime, updateRun, setRuntime, updateSessionModel]);

  const uploadAttachment = useCallback(async (agentId: string, file: { name: string; mimeType: string; data: string }, signal?: AbortSignal) => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Reconnect to upload attachments.');
    try { return await client.uploadAttachment(file, signal); }
    catch (error) {
      if (error instanceof HermesRequestError && error.status === 404) throw new Error('Update the connector on this agent to send attachments.');
      throw error;
    }
  }, []);
  const attachmentSource = useCallback((agentId: string, id: string) => clients.current.get(agentId)?.attachmentSource(id), []);

  const skills = useCallback(async (agentId: string) => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Reconnect to load skills.');
    return client.skills();
  }, []);

  const models = useCallback(async (agentId: string): Promise<readonly HermesModel[]> => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Reconnect to load models.');
    return client.models();
  }, []);

  const toolsets = useCallback(async (agentId: string) => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Reconnect to load toolsets.');
    return client.toolsets();
  }, []);

  const sessionDetail = useCallback(async (agentId: string, sessionId: string) => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Reconnect to load the thread model.');
    const previousModel = runtimeRef.current[agentId]?.sessions.find((item) => item.id === sessionId)?.model;
    const session = await client.session(sessionId);
    setRuntime((current) => {
      const state = current[agentId];
      if (!state) return current;
      if (state.sessions.find((item) => item.id === sessionId)?.model !== previousModel) return current;
      const existing = state.sessions.some((item) => item.id === session.id);
      const sessions = existing ? state.sessions.map((item) => item.id === session.id ? { ...item, ...session } : item) : [session, ...state.sessions];
      return { ...current, [agentId]: { ...state, sessions } };
    });
    return session;
  }, [setRuntime]);

  const steerRun = useCallback(async (agentId: string, runId: string, input: string) => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Reconnect to steer the run.');
    await client.steerRun(runId, input);
  }, []);

  const deleteSession = useCallback(async (agentId: string, sessionId: string): Promise<void> => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Connect to the agent to update threads.');
    await client.deleteSession(sessionId);
    setRuntime((current) => {
      const state = current[agentId];
      if (!state) return current;
      return { ...current, [agentId]: { ...state, sessions: state.sessions.filter((session) => session.id !== sessionId) } };
    });
    setMessages((current) => {
      const next = { ...current };
      delete next[`${agentId}:${sessionId}`];
      return next;
    });
  }, [setRuntime]);

  const setPinned = useCallback(async (agentId: string, sessionId: string, pinned: boolean): Promise<void> => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Connect to the agent to update threads.');
    await client.setPinned(sessionId, pinned);
    setRuntime((current) => {
      const state = current[agentId];
      if (!state) return current;
      return { ...current, [agentId]: { ...state, sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, pinned } : session) } };
    });
  }, [setRuntime]);

  const forkSession = useCallback(async (agentId: string, sessionId: string): Promise<string> => {
    let client = clients.current.get(agentId);
    if (!client) {
      await refreshAgent(agentId);
      client = clients.current.get(agentId);
    }
    if (!client) throw new Error('Agent is offline');
    const session = await client.forkSession(sessionId);
    setRuntime((current) => {
      const existing = current[agentId] ?? emptyRuntime();
      return { ...current, [agentId]: { ...existing, sessions: [session, ...existing.sessions.filter((item) => item.id !== session.id)] } };
    });
    return session.id;
  }, [refreshAgent, setRuntime]);

  const regenerateTitle = useCallback(async (agentId: string, sessionId: string, input: string): Promise<string | undefined> => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Connect to the agent to update threads.');
    const title = await client.generateSessionTitle(sessionId, input);
    if (title) setRuntime((current) => {
      const state = current[agentId];
      return state ? { ...current, [agentId]: { ...state, sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, title } : session) } } : current;
    });
    return title;
  }, [setRuntime]);

  const stopRun = useCallback(async (agentId: string, runId: string): Promise<HermesRunStatus> => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Agent is offline');
    const status = await client.stopRun(runId);
    updateRun(agentId, status);
    posthog.capture('run_stopped', { agent_id: agentId, run_id: runId });
    return status;
  }, [updateRun]);

  const createSession = useCallback(async (agentId: string, title?: string, sessionId?: string, signal?: AbortSignal): Promise<string> => {
    let client = clients.current.get(agentId);
    if (!client) {
      await refreshAgent(agentId);
      client = clients.current.get(agentId);
    }
    if (!client) throw new Error('Agent is offline');
    const session = await client.createSession({ title, id: sessionId }, signal);
    newSessions.current.add(`${agentId}:${session.id}`);
    setRuntime((current) => {
      const existing = current[agentId] ?? emptyRuntime();
      return { ...current, [agentId]: { ...existing, sessions: [session, ...existing.sessions.filter((item) => item.id !== session.id)] } };
    });
    posthog.capture('session_created', { agent_id: agentId, session_id: session.id });
    return session.id;
  }, [refreshAgent, setRuntime]);

  const saveInbox = useCallback(async (agentId: string, settled: InboxSettledState, importOnly = false, config?: InboxConfig): Promise<void> => {
    const client = clients.current.get(agentId);
    if (!client) throw new Error('Connect to the agent to update finished threads.');
    const saved = await client.inbox(settled, importOnly, config);
    setRuntime((current) => {
      const state = current[agentId];
      if (!state) return current;
      return { ...current, [agentId]: { ...state, sessions: state.sessions.map((session) => {
        const config = saved.config[session.id];
        return { ...session, settledAt: saved.settled[session.id], ...(config ? { autoSettleDisabled: config.auto_settle === false } : {}) };
      }) } };
    });
  }, [setRuntime]);

  const sessionMessages = useCallback(async (agentId: string, sessionId: string): Promise<readonly HermesMessage[]> => {
    let client = clients.current.get(agentId);
    if (!client) {
      await refreshAgent(agentId);
      client = clients.current.get(agentId);
    }
    if (!client) throw new Error('Agent is offline');
    const loaded = await client.sessionMessages(sessionId);
    setMessages((current) => ({ ...current, [`${agentId}:${sessionId}`]: reconcileHistory(current[`${agentId}:${sessionId}`] ?? [], loaded) }));
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
      if (!existing || !existing.runs[runId]) return current;
      return { ...current, [agentId]: { ...existing, runs: { ...existing.runs, [runId]: status }, events: [...existing.events, { event: 'approval.responded', runId }] } };
    });
    posthog.capture(choice === 'deny' ? 'run_denied' : 'run_approved', {
      agent_id: agentId,
      run_id: runId,
      approval_scope: choice,
    });
    return result;
  }, [setRuntime]);

  const retryAgent = useCallback((agentId: string) => refreshAgent(agentId), [refreshAgent]);

  const notificationClient = useCallback(async (agentId: string) => {
    const agent = catalog.get(agentId);
    if (!agent) throw new Error('Agent is no longer paired.');
    const accessToken = await catalog.credentials.get(agentId);
    if (!accessToken) throw new Error('Pair this device again to manage notifications.');
    return createNotificationRegistrationClient({ endpoint: agent.endpoint.url, accessToken });
  }, [catalog]);

  const removeAgent = useCallback(async (agentId: string) => {
    const client = await notificationClient(agentId);
    try { await client.unregister(); }
    catch (error) {
      // Revoked credentials and older connectors have no registration to remove.
      if (!(error && typeof error === 'object' && 'status' in error && [401, 404].includes(Number(error.status)))) throw error;
    }
    closeSubscription(agentId);
    clients.current.delete(agentId);
    await catalog.remove(agentId);
    posthog.capture('agent_removed', { agent_id: agentId });
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
  }, [catalog, closeSubscription, notificationClient, setRuntime]);

  const hasSession = useCallback((agentId: string, sessionId: string) => runtimeRef.current[agentId]?.sessions.some((session) => session.id === sessionId) ?? false, []);

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
    deleteSession,
    setPinned,
    forkSession,
    regenerateTitle,
    models,
    toolsets,
    sessionDetail,
    setSessionModel,
    steerRun,
    sessionMessages,
    skills,
    saveInbox,
    uploadAttachment,
    attachmentSource,
    stopRun,
    approveRun,
    removeAgent,
    notificationClient,
    hasSession,
  }), [toolsets, sessionDetail, setSessionModel, steerRun, notificationClient, hasSession, saveInbox, agents, attachmentSource, uploadAttachment, approveRun, createSession, deleteSession, setPinned, forkSession, regenerateTitle, models, error, loading, messages, pair, refreshAgent, removeAgent, retryAgent, runtime, sessionMessages, skills, startRun, stopRun]);

  return <EkhoContext.Provider value={value}>{children}</EkhoContext.Provider>;
}

export function useEkho(): EkhoContextValue {
  const value = useContext(EkhoContext);
  if (!value) throw new Error('useEkho must be used inside EkhoProvider');
  return value;
}
