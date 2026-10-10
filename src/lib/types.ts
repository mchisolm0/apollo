export type AgentTransport = 'tailscale' | 'https' | 'lan';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'offline' | 'revoked';

export interface AgentEndpoint {
  url: string;
  transport: AgentTransport;
}

/** Non-secret metadata. The token is intentionally stored separately. */
export interface AgentRecord {
  id: string;
  label: string;
  hostname?: string;
  deviceName?: string;
  endpoint: AgentEndpoint;
  createdAt: number;
  lastConnectedAt?: number;
  activeRunIds?: readonly string[];
  capabilities?: HermesCapabilities;
}

export interface PairingDescriptor {
  id: string;
  label: string;
  hostname?: string;
  connectorVersion?: string;
  capabilities?: HermesCapabilities;
  exchangePath: string;
}

export interface PairingInput {
  endpoint: string;
  bootstrapToken: string;
}

export interface PairingResult {
  descriptor: PairingDescriptor;
  accessToken: string;
  deviceId?: string;
  expiresIn?: number;
  /** The cloud inbox grant, when the connector has one configured. */
  cloud?: { url: string; token: string };
}

export interface HermesCapabilities {
  object?: string;
  platform?: string;
  model?: string;
  auth?: { type?: string; required?: boolean };
  features: Record<string, boolean | string | Record<string, unknown>>;
  endpoints?: Record<string, { method?: string; path?: string }>;
}

export type InboxSettledState = Readonly<Record<string, number | null>>;

/** Per-session connector config shared across paired devices. Only auto_settle exists today; absent means default (on). */
export type InboxConfig = Readonly<Record<string, { auto_settle?: boolean }>>;

export interface HermesSkill {
  name: string;
  description?: string;
  category?: string;
}

/** A model from Hermes's provider inventory or compatibility model list. */
export interface HermesModel {
  id: string;
  label?: string;
  provider?: string;
  default?: boolean;
}

export interface HermesToolset {
  name: string;
  label?: string;
  description?: string;
  enabled: boolean;
  configured: boolean;
  tools: readonly string[];
}

export interface HermesModelLock {
  sessionId: string;
  model: string;
  provider?: string;
}

export interface HermesSession {
  settledAt?: number | null;
  /** Server-side auto-settle opt-out from the connector inbox config; absent means no server opinion. */
  autoSettleDisabled?: boolean;
  id: string;
  source?: string;
  model?: string;
  title?: string;
  /** Model for new sends, resolved from server detail with a matching cached provider. */
  selectedModel?: HermesModel;
  startedAt?: number;
  endedAt?: number;
  endReason?: string;
  messageCount?: number;
  lastActive?: number;
  parentSessionId?: string;
  pinned?: boolean;
  archived?: boolean;
  hidden?: boolean;
  preview?: string;
}

export interface HermesMessage {
  id?: string;
  sessionId?: string;
  role: string;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: readonly Record<string, unknown>[];
  timestamp?: number;
  finishReason?: string;
  reasoning?: string;
  reasoningContent?: string;
  displayKind?: string;
}

export type HermesRunState =
  | 'queued'
  | 'started'
  | 'running'
  | 'waiting_for_approval'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface HermesRunStatus {
  runId: string;
  status: HermesRunState;
  sessionId?: string;
  model?: string;
  output?: string;
  error?: string;
  lastEvent?: string;
  createdAt?: number;
  updatedAt?: number;
  approval?: HermesApprovalRequest;
  usage?: Record<string, number>;
}

export interface HermesApprovalRequest {
  requestId?: string;
  command?: string;
  tool?: string;
  description?: string;
  choices?: readonly string[];
  [key: string]: unknown;
}

export interface HermesRunEvent {
  event: string;
  runId?: string;
  timestamp?: number;
  text?: string;
  tool?: string;
  preview?: string;
  [key: string]: unknown;
}

export interface StartRunOptions {
  signal?: AbortSignal;
  attachments?: readonly import('./attachments').Attachment[];
  sessionId?: string;
  instructions?: string;
  conversationHistory?: readonly { role: string; content: string }[];
  previousResponseId?: string;
  model?: string;
  // No reasoning/tier/runtime params: the /v1/runs payload contract has no such fields.
  provider?: string;
  sessionKey?: string;
  idempotencyKey?: string;
}

export interface ApprovalOptions {
  requestId?: string;
  all?: boolean;
  resolveAll?: boolean;
}

export interface HermesApprovalResponse {
  runId: string;
  choice: 'once' | 'session' | 'always' | 'deny';
  resolved: number;
  requestId?: string;
}

export interface AgentRuntimeState {
  status: ConnectionStatus;
  error?: string;
  capabilities?: HermesCapabilities;
  sessions: readonly HermesSession[];
  runs: Readonly<Record<string, HermesRunStatus>>;
  events: readonly HermesRunEvent[];
}
