import { attachmentMessage, isAttachment, type Attachment, type AttachmentSource } from './attachments';
import { normalizeEndpoint } from './endpoint';
import { parseSkills } from './skills';
import EventSource, { type EventSourceListener } from 'react-native-sse';

import {
  booleanValue,
  errorMessage,
  isJsonObject,
  numberValue,
  stringValue,
} from './protocol';
import type {
  ApprovalOptions,
  HermesApprovalRequest,
  HermesApprovalResponse,
  HermesCapabilities,
  HermesMessage,
  HermesModel,
  HermesRunEvent,
  HermesRunState,
  HermesRunStatus,
  HermesSession,
  InboxConfig,
  InboxSettledState,
  StartRunOptions,
} from './types';

export class HermesRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'HermesRequestError';
    this.status = status;
    this.code = code;
  }
}

export interface RunEventSubscription {
  close(): void;
}

export interface RunEventHandlers {
  onEvent(event: HermesRunEvent): void;
  onError?(error: Error): void;
}

function parseCapabilities(value: unknown): HermesCapabilities {
  if (!isJsonObject(value)) throw new Error('Hermes capabilities response was invalid');
  const features: Record<string, boolean | string | Record<string, unknown>> = {};
  if (isJsonObject(value.features)) {
    for (const [key, feature] of Object.entries(value.features)) {
      if (typeof feature === 'boolean' || typeof feature === 'string' || isJsonObject(feature)) {
        features[key] = feature;
      }
    }
  } else if (Array.isArray(value.features)) {
    for (const feature of value.features) {
      if (typeof feature === 'string') features[feature] = true;
    }
  }
  const endpoints: Record<string, { method?: string; path?: string }> = {};
  if (isJsonObject(value.endpoints)) {
    for (const [key, endpoint] of Object.entries(value.endpoints)) {
      if (isJsonObject(endpoint)) {
        endpoints[key] = { method: stringValue(endpoint.method), path: stringValue(endpoint.path) };
      }
    }
  }
  return {
    object: stringValue(value.object),
    platform: stringValue(value.platform),
    model: stringValue(value.model),
    auth: isJsonObject(value.auth)
      ? { type: stringValue(value.auth.type), required: booleanValue(value.auth.required) }
      : undefined,
    features,
    endpoints,
  };
}

function parseSession(value: unknown): HermesSession {
  if (!isJsonObject(value) || typeof value.id !== 'string') throw new Error('Hermes session response was invalid');
  return {
    id: value.id,
    source: stringValue(value.source),
    model: stringValue(value.model),
    title: stringValue(value.title),
    startedAt: numberValue(value.started_at),
    endedAt: numberValue(value.ended_at),
    endReason: stringValue(value.end_reason),
    messageCount: numberValue(value.message_count),
    lastActive: numberValue(value.last_active),
    parentSessionId: stringValue(value.parent_session_id),
    pinned: booleanValue(value.pinned),
    archived: booleanValue(value.archived),
    hidden: booleanValue(value.hidden),
    preview: stringValue(value.preview),
  };
}

/** Tolerant model list parser (parseSkills style): unknown shapes yield [], malformed entries are skipped, never throws. */
export function parseModels(value: unknown): readonly HermesModel[] {
  const list = Array.isArray(value)
    ? value
    : isJsonObject(value) && Array.isArray(value.data)
      ? value.data
      : isJsonObject(value) && Array.isArray(value.models)
        ? value.models
        : undefined;
  if (!list) return [];
  const models = new Map<string, HermesModel>();
  for (const entry of list) {
    if (!isJsonObject(entry)) continue;
    const id = typeof entry.id === 'string' && entry.id.trim()
      ? entry.id
      : typeof entry.name === 'string' && entry.name.trim()
        ? entry.name
        : undefined;
    if (!id) continue;
    models.set(id, {
      id,
      label: stringValue(entry.label) ?? stringValue(entry.display_name),
      provider: stringValue(entry.provider) ?? stringValue(entry.owned_by),
      default: booleanValue(entry.default) ?? booleanValue(entry.is_default),
    });
  }
  return [...models.values()];
}

function parseMessage(value: unknown): HermesMessage {
  if (!isJsonObject(value) || typeof value.role !== 'string') throw new Error('Hermes message response was invalid');
  const toolCalls = Array.isArray(value.tool_calls)
    ? value.tool_calls.filter(isJsonObject)
    : undefined;
  return {
    id: stringValue(value.id),
    sessionId: stringValue(value.session_id),
    role: value.role,
    content: stringValue(value.content),
    toolCallId: stringValue(value.tool_call_id),
    toolName: stringValue(value.tool_name),
    toolCalls,
    timestamp: numberValue(value.timestamp),
    finishReason: stringValue(value.finish_reason),
    reasoning: stringValue(value.reasoning),
    reasoningContent: stringValue(value.reasoning_content),
    displayKind: stringValue(value.display_kind),
  };
}

const runStates = new Set<HermesRunState>([
  'queued', 'started', 'running', 'waiting_for_approval', 'stopping',
  'completed', 'failed', 'cancelled', 'interrupted',
]);

function parseRun(value: unknown): HermesRunStatus {
  if (!isJsonObject(value) || typeof value.run_id !== 'string' || typeof value.status !== 'string') {
    throw new Error('Hermes run response was invalid');
  }
  if (!runStates.has(value.status as HermesRunState)) throw new Error(`Unknown Hermes run status: ${value.status}`);
  const status = value.status as HermesRunState;
  const approval = isJsonObject(value.approval) ? value.approval as HermesApprovalRequest : undefined;
  const usage = isJsonObject(value.usage)
    ? Object.fromEntries(Object.entries(value.usage).flatMap(([key, item]) => typeof item === 'number' ? [[key, item]] : []))
    : undefined;
  return {
    runId: value.run_id,
    status,
    sessionId: stringValue(value.session_id),
    model: stringValue(value.model),
    output: stringValue(value.output),
    error: stringValue(value.error),
    lastEvent: stringValue(value.last_event),
    createdAt: numberValue(value.created_at),
    updatedAt: numberValue(value.updated_at),
    approval,
    usage,
  };
}

function parseEvent(value: unknown): HermesRunEvent | undefined {
  if (!isJsonObject(value) || typeof value.event !== 'string') return undefined;
  return {
    ...value,
    event: value.event,
    runId: stringValue(value.run_id),
    timestamp: numberValue(value.timestamp),
    text: stringValue(value.text),
    tool: stringValue(value.tool),
    preview: stringValue(value.preview),
  };
}

function createIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  const cryptoApi = (globalThis as typeof globalThis & {
    crypto?: { getRandomValues(values: Uint8Array): Uint8Array };
  }).crypto;
  if (cryptoApi) cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class HermesClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { endpoint: string; token: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = normalizeEndpoint(options.endpoint);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/${path.replace(/^\/+/, '')}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {}),
      },
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = isJsonObject(body) && isJsonObject(body.error) ? stringValue(body.error.code) : undefined;
      throw new HermesRequestError(errorMessage(body, `Hermes request failed (${response.status})`), response.status, code);
    }
    return body;
  }

  async capabilities(): Promise<HermesCapabilities> {
    return parseCapabilities(await this.request('/v1/capabilities'));
  }

  async skills() {
    return parseSkills(await this.request('/v1/skills'));
  }

  async sessions(): Promise<readonly HermesSession[]> {
    const [body, inbox] = await Promise.all([this.request('/api/sessions?limit=200'), this.inbox()]);
    if (!isJsonObject(body) || !Array.isArray(body.data)) throw new Error('Hermes sessions response was invalid');
    return body.data.map((value) => {
      const session = parseSession(value);
      const config = inbox.config[session.id];
      return { ...session, settledAt: inbox.settled[session.id], ...(config ? { autoSettleDisabled: config.auto_settle === false } : {}) };
    });
  }

  async inbox(settled?: InboxSettledState, importOnly = false, config?: InboxConfig): Promise<{ settled: InboxSettledState; config: InboxConfig }> {
    const payload: Record<string, unknown> = { importOnly };
    if (settled) payload.settled = settled;
    if (config) payload.config = config;
    let body: unknown;
    try {
      body = await this.request('/v1/inbox', settled || config ? {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      } : {});
    } catch (error) {
      if (error instanceof HermesRequestError && error.status === 404) {
        if (!settled && !config) return { settled: {}, config: {} };
        throw new Error('Update the Ekho connector to sync finished threads.');
      }
      throw error;
    }
    if (!isJsonObject(body) || !isJsonObject(body.settled)) throw new Error('Invalid inbox response');
    const result: Record<string, number | null> = {};
    for (const [id, timestamp] of Object.entries(body.settled)) {
      if (timestamp !== null && (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0)) throw new Error('Invalid inbox timestamp');
      result[id] = timestamp;
    }
    const parsedConfig: Record<string, { auto_settle?: boolean }> = {};
    if (isJsonObject(body.config)) {
      for (const [id, entry] of Object.entries(body.config)) {
        if (!isJsonObject(entry) || typeof entry.auto_settle !== 'boolean') continue;
        parsedConfig[id] = { auto_settle: entry.auto_settle };
      }
    }
    return { settled: result, config: parsedConfig };
  }

  async sessionMessages(sessionId: string): Promise<readonly HermesMessage[]> {
    const body = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    if (!isJsonObject(body) || !Array.isArray(body.data)) throw new Error('Hermes messages response was invalid');
    return body.data.map(parseMessage);
  }

  async uploadAttachment(file: { name: string; mimeType: string; data: string }): Promise<Attachment> {
    const body = await this.request('/v1/ekho/attachments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(file) });
    if (!isJsonObject(body) || !isAttachment(body.attachment)) throw new Error('The attachment upload response was invalid.');
    return body.attachment;
  }

  attachmentSource(id: string): AttachmentSource {
    return { uri: `${this.baseUrl}/v1/ekho/attachments/${encodeURIComponent(id)}`, headers: { Authorization: `Bearer ${this.token}` } };
  }

  async generateSessionTitle(sessionId: string, input: string): Promise<string | undefined> {
    const body = await this.request('/v1/ekho/thread-title', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
    if (!isJsonObject(body) || typeof body.title !== 'string' || !body.title.trim()) return undefined;
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: body.title }) });
    return body.title;
  }

  async createSession(options: { id?: string; title?: string } = {}): Promise<HermesSession> {
    let body: unknown;
    try {
      body = await this.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });
    } catch (error) {
      // A queued thread keeps its client-generated ID across ambiguous requests.
      if (!options.id || !(error instanceof HermesRequestError) || error.status !== 409 || error.code !== 'session_exists') throw error;
      body = await this.request(`/api/sessions/${encodeURIComponent(options.id)}`);
    }
    if (!isJsonObject(body)) throw new Error('Hermes create session response was invalid');
    const session = parseSession(body.session);
    if (options.id && session.id !== options.id) throw new Error('The agent returned a different thread than requested.');
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    });
  }

  async models(): Promise<readonly HermesModel[]> {
    return parseModels(await this.request('/v1/models'));
  }

  /** POST /api/sessions/:id/fork is proxied by the connector (index.mjs); surfaces the branched session. */
  async forkSession(sessionId: string): Promise<HermesSession> {
    const body = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, { method: 'POST' });
    if (!isJsonObject(body)) throw new Error('Hermes fork session response was invalid');
    return parseSession(isJsonObject(body.session) ? body.session : body);
  }

  async startRun(input: string, options: StartRunOptions = {}): Promise<HermesRunStatus> {
    if (!input.trim() && !options.attachments?.length) throw new Error('Run input cannot be empty');
    const payload: Record<string, unknown> = { input: attachmentMessage(input, options.attachments) };
    if (options.sessionId) payload.session_id = options.sessionId;
    if (options.instructions) payload.instructions = options.instructions;
    if (options.conversationHistory) payload.conversation_history = options.conversationHistory;
    if (options.previousResponseId) payload.previous_response_id = options.previousResponseId;
    if (options.model) payload.model = options.model;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Idempotency-Key': options.idempotencyKey ?? createIdempotencyKey(),
    };
    if (options.sessionKey) headers['X-Hermes-Session-Key'] = options.sessionKey;
    return parseRun(await this.request('/v1/runs', { method: 'POST', headers, body: JSON.stringify(payload) }));
  }

  runStatus(runId: string): Promise<HermesRunStatus> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}`).then(parseRun);
  }

  async stopRun(runId: string): Promise<HermesRunStatus> {
    return parseRun(await this.request(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }));
  }

  async approveRun(runId: string, choice: 'once' | 'session' | 'always' | 'deny', options: ApprovalOptions = {}): Promise<HermesApprovalResponse> {
    const body: Record<string, unknown> = { choice };
    if (options.requestId) body.request_id = options.requestId;
    if (options.all !== undefined) body.all = options.all;
    if (options.resolveAll !== undefined) body.resolve_all = options.resolveAll;
    const response = await this.request(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!isJsonObject(response) || typeof response.run_id !== 'string' || typeof response.choice !== 'string' || typeof response.resolved !== 'number') {
      throw new Error('Hermes approval response was invalid');
    }
    if (!['once', 'session', 'always', 'deny'].includes(response.choice)) {
      throw new Error('Hermes approval response contained an invalid choice');
    }
    return {
      runId: response.run_id,
      choice: response.choice as HermesApprovalResponse['choice'],
      resolved: response.resolved,
      requestId: stringValue(response.request_id),
    };
  }

  subscribeRunEvents(runId: string, handlers: RunEventHandlers): RunEventSubscription {
    const source = new EventSource<never>(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Authorization: `Bearer ${this.token}` },
      pollingInterval: 5_000,
      timeoutBeforeConnection: 0,
    });
    const onMessage: EventSourceListener<never, 'message'> = (event) => {
      if (typeof event.data !== 'string' || !event.data) return;
      try {
        const parsed = parseEvent(JSON.parse(event.data) as unknown);
        if (parsed) handlers.onEvent(parsed);
      } catch (error) {
        handlers.onError?.(error instanceof Error ? error : new Error('Invalid Hermes event'));
      }
    };
    const onError: EventSourceListener<never, 'error'> = (event) => {
      const message = 'message' in event && typeof event.message === 'string' ? event.message : 'Hermes event stream failed';
      handlers.onError?.(new Error(message));
    };
    source.addEventListener('message', onMessage);
    source.addEventListener('error', onError);
    return {
      close: () => {
        source.removeAllEventListeners();
        source.close();
      },
    };
  }
}
