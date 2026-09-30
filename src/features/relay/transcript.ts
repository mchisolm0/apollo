import { eventTransportIdentity } from '../../lib/run-state.ts';
import type { HermesMessage, HermesRunEvent, HermesRunState } from '../../lib/types';
import { toSeconds, toolTarget } from './activity.ts';

export type TranscriptStatus = 'running' | 'complete' | 'failed';

/** One tool call. `input` is the call's target (command, path, query), `output` its result preview. */
export interface TranscriptToolStep {
  readonly id: string;
  readonly kind: 'tool';
  readonly name: string;
  readonly input: string;
  readonly output: string;
  readonly status: TranscriptStatus;
  /** Seconds, when Hermes reported it. */
  readonly duration?: number;
}

/** Commentary the agent wrote mid-turn, before its final answer. */
export interface TranscriptNoteStep {
  readonly id: string;
  readonly kind: 'note';
  readonly text: string;
}

/** Reasoning text the provider chose to expose. */
export interface TranscriptThoughtStep {
  readonly id: string;
  readonly kind: 'thought';
  readonly text: string;
}

export type TranscriptStep = TranscriptToolStep | TranscriptNoteStep | TranscriptThoughtStep;

export interface TranscriptMessageRow {
  readonly id: string;
  readonly kind: 'user' | 'assistant' | 'error';
  readonly text: string;
  readonly status?: TranscriptStatus;
  /** Unix seconds or milliseconds, from durable history. */
  readonly timestamp?: number;
}

export type ActivityStatus = TranscriptStatus | 'stopped';

/** Run states worth naming while a turn is active. `starting` covers the send before a run exists. */
export type ActivityPhase = 'starting' | 'working' | 'approval' | 'stopping';

/**
 * Everything the agent did during one turn before its final answer, folded
 * into a single row. A running turn always has one, even before any step.
 */
export interface TranscriptActivityRow {
  readonly id: string;
  readonly kind: 'activity';
  readonly status: ActivityStatus;
  readonly phase?: ActivityPhase;
  readonly steps: readonly TranscriptStep[];
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export type TranscriptRow = TranscriptMessageRow | TranscriptActivityRow;

export interface TranscriptProjectionInput {
  readonly history: readonly HermesMessage[];
  readonly events: readonly HermesRunEvent[];
  readonly runId?: string;
  /** Unix seconds or milliseconds, used to distinguish an older equal answer and to time the turn. */
  readonly runStartedAt?: number;
  /** Last status change of the current run; ends the timer of a settled live turn. */
  readonly runEndedAt?: number;
  readonly runStatus?: HermesRunState;
  readonly runOutput?: string;
  readonly running: boolean;
}

export type TranscriptProjector = (input: TranscriptProjectionInput) => readonly TranscriptRow[];

type WorkStep = TranscriptToolStep | TranscriptThoughtStep;

// Tool calls and reasoning between messages, before a turn folds them into its activity.
interface WorkRow {
  readonly id: string;
  readonly kind: 'work';
  readonly steps: readonly WorkStep[];
}

type FlatRow = TranscriptMessageRow | WorkRow;

type MessageDescriptor = {
  readonly key: string;
  readonly kind: 'user' | 'assistant' | 'error';
  readonly text: string;
  readonly status: TranscriptStatus;
  readonly timestamp?: number;
};

type WorkDescriptor = {
  readonly key: string;
  readonly kind: 'work';
  readonly steps: readonly WorkStep[];
};

type RowDescriptor = MessageDescriptor | WorkDescriptor;

type HistoryCache = {
  readonly keys: readonly string[];
  readonly rows: readonly FlatRow[];
  readonly lastAssistantText?: string;
  readonly lastAssistantId?: string;
  readonly lastAssistantTimestamp?: number;
};

type LiveAtom =
  | {
      kind: 'assistant';
      key: string;
      text: string;
      status: TranscriptStatus;
      messageId?: string;
    }
  | {
      kind: 'tool';
      key: string;
      name: string;
      input: string;
      output: string;
      status: TranscriptStatus;
      duration?: number;
      identity?: string;
    }
  | {
      kind: 'thought';
      key: string;
      text: string;
    }
  | {
      kind: 'error';
      key: string;
      text: string;
      status: 'failed';
    };

type LiveCache = {
  readonly keys: readonly string[];
  readonly runKey: string;
  readonly atoms: readonly LiveAtom[];
  readonly rows: readonly FlatRow[];
  readonly failed: boolean;
  readonly terminal: boolean;
};

const EMPTY = '';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: HermesRunEvent | Record<string, unknown>, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const candidate = stringValue(value[name]);
    if (candidate) return candidate;
  }
  return undefined;
}

function statusForMessage(message: HermesMessage, kind: MessageDescriptor['kind']): TranscriptStatus {
  if (kind === 'error') return 'failed';
  const finishReason = message.finishReason?.toLowerCase();
  return finishReason === 'error' || finishReason === 'failed' ? 'failed' : 'complete';
}

function messageKey(message: HermesMessage, index: number, occurrence: number): string {
  const identity = message.id ?? `index-${index}`;
  return `history-message-${identity}-${occurrence}`;
}

function historyFingerprint(message: HermesMessage, index: number): string {
  const calls = message.toolCalls?.map((call) => `${toolIdentity(call) ?? ''}:${callName(call) ?? ''}:${JSON.stringify(callArguments(call))}`).join('|') ?? '';
  return [message.id ?? `index-${index}`, message.role, message.content, message.reasoningContent, message.reasoning, message.toolCallId, message.toolName, calls].map((value) => value ?? '').join('\u001f');
}

function toolText(value: Record<string, unknown>): string {
  return field(value, 'text', 'summary', 'preview', 'description', 'message') ?? EMPTY;
}

function toolIdentity(value: Record<string, unknown>): string | undefined {
  return field(value, 'tool_call_id', 'toolCallId', 'call_id', 'callId', 'id');
}

// Durable tool calls use the OpenAI shape: { id, function: { name, arguments } }.
function callName(call: Record<string, unknown>): string | undefined {
  return field(call, 'name', 'tool', 'tool_name', 'toolName') ?? (isRecord(call.function) ? stringValue(call.function.name) : undefined);
}

function callArguments(call: Record<string, unknown>): Record<string, unknown> {
  const raw = isRecord(call.function) ? call.function.arguments : call.arguments;
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Hermes tool results are JSON; a failed call reports success: false, an error, or a non-zero exit code. */
function resultFailed(content: string | undefined): boolean {
  if (!content?.trimStart().startsWith('{')) return false;
  try {
    const result: unknown = JSON.parse(content);
    if (!isRecord(result)) return false;
    return result.success === false || Boolean(stringValue(result.error)) || (typeof result.exit_code === 'number' && result.exit_code !== 0);
  } catch {
    return false;
  }
}

function sameStep(previous: TranscriptStep, next: TranscriptStep): boolean {
  if (previous.id !== next.id || previous.kind !== next.kind) return false;
  if (previous.kind === 'tool' && next.kind === 'tool') {
    return previous.name === next.name && previous.input === next.input && previous.output === next.output && previous.status === next.status && previous.duration === next.duration;
  }
  return previous.kind !== 'tool' && next.kind !== 'tool' && previous.text === next.text;
}

/** Reuse unchanged step objects so memoized rows skip re-rendering. */
function stableSteps<T extends TranscriptStep>(next: readonly T[], previous: readonly TranscriptStep[]): readonly T[] {
  const prior = new Map(previous.map((step) => [step.id, step]));
  return next.map((step) => {
    const match = prior.get(step.id);
    return match && sameStep(match, step) ? match as T : step;
  });
}

function sameSteps(previous: readonly TranscriptStep[], next: readonly TranscriptStep[]): boolean {
  return previous.length === next.length && next.every((step, index) => step === previous[index]);
}

function descriptorsToRows(descriptors: readonly RowDescriptor[], previous: readonly FlatRow[] = []): readonly FlatRow[] {
  const previousByKey = new Map<string, FlatRow>();
  for (const row of previous) previousByKey.set(row.id, row);

  return descriptors.map((descriptor) => {
    const id = descriptor.key;
    const prior = previousByKey.get(id);
    if (descriptor.kind === 'work') {
      const steps = stableSteps(descriptor.steps, prior?.kind === 'work' ? prior.steps : []);
      if (prior?.kind === 'work' && sameSteps(prior.steps, steps)) return prior;
      return { id, kind: 'work', steps } satisfies WorkRow;
    }
    if (prior?.kind === descriptor.kind && prior.text === descriptor.text && prior.status === descriptor.status && prior.timestamp === descriptor.timestamp) return prior;
    return { id, kind: descriptor.kind, text: descriptor.text, status: descriptor.status, timestamp: descriptor.timestamp } satisfies TranscriptMessageRow;
  });
}

function buildHistory(history: readonly HermesMessage[], previous?: HistoryCache): HistoryCache {
  const keys = history.map(historyFingerprint);
  if (previous && previous.keys.length === keys.length && keys.every((key, index) => key === previous.keys[index])) return previous;

  const descriptors: RowDescriptor[] = [];
  const seenToolIds = new Map<string, number>();
  const toolPositions = new Map<string, { descriptorIndex: number; stepIndex: number }>();
  const messageOccurrences = new Map<string, number>();
  const pushStep = (step: WorkStep, identity?: string) => {
    const last = descriptors.at(-1);
    if (last?.kind === 'work') {
      descriptors[descriptors.length - 1] = { ...last, steps: [...last.steps, step] };
      if (identity) toolPositions.set(identity, { descriptorIndex: descriptors.length - 1, stepIndex: last.steps.length });
    } else {
      descriptors.push({ key: `history-work-${step.id}`, kind: 'work', steps: [step] });
      if (identity) toolPositions.set(identity, { descriptorIndex: descriptors.length - 1, stepIndex: 0 });
    }
  };
  // A call and its result arrive as separate messages; the shared call id merges them into one step.
  const pushTool = (baseKey: string, call: { identity?: string; name?: string; input?: string; output?: string }, index: number, status: TranscriptStatus) => {
    const { identity } = call;
    const position = identity ? toolPositions.get(identity) : undefined;
    const work = position ? descriptors[position.descriptorIndex] : undefined;
    const existing = position && work?.kind === 'work' ? work.steps[position.stepIndex] : undefined;
    if (position && work?.kind === 'work' && existing?.kind === 'tool') {
      const steps = [...work.steps];
      steps[position.stepIndex] = {
        ...existing,
        name: call.name ?? existing.name,
        input: call.input || existing.input,
        output: call.output || existing.output,
        status,
      };
      descriptors[position.descriptorIndex] = { ...work, steps };
      return;
    }
    const identityCount = identity ? (seenToolIds.get(identity) ?? 0) : 0;
    if (identity) seenToolIds.set(identity, identityCount + 1);
    const id = `history-tool-${identity ?? `${baseKey}-${index}`}-${identityCount}`;
    pushStep({ id, kind: 'tool', name: call.name ?? 'tool', input: call.input ?? EMPTY, output: call.output ?? EMPTY, status }, identity);
  };
  const pushCalls = (key: string, message: HermesMessage) => {
    for (const [toolIndex, rawCall] of message.toolCalls?.entries() ?? []) {
      const name = callName(rawCall);
      pushTool(key, { identity: toolIdentity(rawCall), name, input: (name && toolTarget(name, callArguments(rawCall))) || toolText(rawCall) }, toolIndex, 'complete');
    }
  };

  let lastAssistantText: string | undefined;
  let lastAssistantId: string | undefined;
  let lastAssistantTimestamp: number | undefined;
  for (const [index, message] of history.entries()) {
    const role = message.role.toLowerCase();
    const text = message.content ?? EMPTY;
    const identity = message.id ?? `index-${index}`;
    const occurrence = messageOccurrences.get(identity) ?? 0;
    messageOccurrences.set(identity, occurrence + 1);
    const key = messageKey(message, index, occurrence);

    if (role === 'tool') {
      pushTool(key, { identity: message.toolCallId, name: message.toolName, output: text }, index, resultFailed(message.content) ? 'failed' : 'complete');
      continue;
    }
    if (role !== 'user' && role !== 'assistant' && role !== 'error') continue;
    const reasoning = role === 'assistant' ? message.reasoningContent ?? message.reasoning : undefined;
    if (reasoning?.trim()) pushStep({ id: `history-thought-${key}`, kind: 'thought', text: reasoning });
    if (!text) {
      if (role === 'assistant') pushCalls(key, message);
      continue;
    }
    const kind: MessageDescriptor['kind'] = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'error';
    descriptors.push({ key: `history-${key}`, kind, text, status: statusForMessage(message, kind), timestamp: message.timestamp });
    if (kind === 'assistant') {
      lastAssistantText = text;
      lastAssistantId = message.id;
      lastAssistantTimestamp = message.timestamp;
      pushCalls(key, message);
    }
  }

  const rows = descriptorsToRows(descriptors, previous?.rows);
  return { keys, rows, lastAssistantText, lastAssistantId, lastAssistantTimestamp };
}

function eventKey(event: HermesRunEvent): string {
  const fields = [
    event.event,
    event.runId,
    event.timestamp,
    eventTransportIdentity(event),
    eventText(event),
    eventToolName(event),
    eventIdentity(event),
    field(event, 'delta'),
    field(event, 'message_id', 'messageId'),
    event.error === true ? 'error' : undefined,
  ];
  return fields.map((value) => value ?? '').join('\u001f');
}

function eventIdentity(event: HermesRunEvent): string | undefined {
  return field(event, 'tool_call_id', 'toolCallId', 'call_id', 'callId', 'id');
}

function eventToolName(event: HermesRunEvent): string {
  return field(event, 'tool', 'tool_name', 'toolName', 'name') ?? 'tool';
}

function eventText(event: HermesRunEvent): string {
  return field(event, 'summary', 'preview', 'text', 'description', 'message', 'error') ?? EMPTY;
}

function eventType(event: HermesRunEvent): string {
  return event.event.toLowerCase();
}

function isToolEvent(type: string): boolean {
  return type.startsWith('tool.') || type.includes('.tool.') || type === 'tool';
}

function isDeltaEvent(type: string): boolean {
  return type === 'message.delta' || type.endsWith('.message.delta') || type === 'assistant.delta' || type === 'text.delta';
}

function toolTransition(type: string): 'start' | 'complete' | 'fail' | 'update' {
  if (/\.(started|start|called|requested|pending)$/.test(type)) return 'start';
  if (/\.(failed|error|cancelled|canceled)$/.test(type)) return 'fail';
  if (/\.(completed|complete|finished|finish|result|succeeded|success)$/.test(type)) return 'complete';
  return 'update';
}

function matchingTool(atoms: readonly LiveAtom[], identity: string | undefined, name: string, matchByName: boolean): number {
  if (identity) {
    const exact = atoms.findIndex((atom) => atom.kind === 'tool' && atom.identity === identity);
    if (exact >= 0) return exact;
  }
  if (!matchByName) return -1;
  for (let index = atoms.length - 1; index >= 0; index -= 1) {
    const atom = atoms[index];
    if (atom.kind === 'tool' && atom.name === name && atom.status === 'running') return index;
  }
  return -1;
}

// tool.started carries the call's target as `preview`; tool.completed carries duration and, on newer Hermes, a result preview.
function pushLiveTool(atoms: LiveAtom[], event: HermesRunEvent, runKey: string, ordinal: number): void {
  const name = eventToolName(event);
  const identity = eventIdentity(event);
  const transition = event.error ? 'fail' : toolTransition(eventType(event));
  const text = eventText(event);
  const duration = typeof event.duration === 'number' && Number.isFinite(event.duration) ? event.duration : undefined;
  const existingIndex = matchingTool(atoms, identity, name, transition !== 'start');
  if (existingIndex >= 0) {
    const existing = atoms[existingIndex];
    if (existing.kind !== 'tool') return;
    atoms[existingIndex] = {
      ...existing,
      name: name === 'tool' ? existing.name : name,
      input: transition === 'start' ? text || existing.input : existing.input,
      output: transition === 'start' ? existing.output : text || existing.output,
      duration: duration ?? existing.duration,
      status: transition === 'fail' ? 'failed' : transition === 'complete' ? 'complete' : existing.status,
    };
    return;
  }
  const status: TranscriptStatus = transition === 'start' ? 'running' : transition === 'fail' ? 'failed' : 'complete';
  const started = transition === 'start';
  atoms.push({ kind: 'tool', key: `live-${runKey}-tool-${identity ?? ordinal}`, identity, name, input: started ? text : EMPTY, output: started ? EMPTY : text, duration, status });
}

function processLiveEvent(atoms: LiveAtom[], event: HermesRunEvent, state: { assistantOrdinal: number; errorOrdinal: number; failed: boolean; terminal: boolean }, runKey: string, running: boolean, eventIndex: number): void {
  if (event.runId && event.runId !== runKey && runKey !== 'stream') return;
  const type = eventType(event);
  if (isDeltaEvent(type)) {
    const delta = field(event, 'delta', 'text');
    if (!delta) return;
    const messageId = field(event, 'message_id', 'messageId');
    const previous = atoms.at(-1);
    if (previous?.kind === 'assistant' && (!messageId || previous.messageId === messageId)) {
      atoms[atoms.length - 1] = { ...previous, text: previous.text + delta, status: running ? previous.status : 'complete' };
    } else {
      const key = `live-${runKey}-assistant-${state.assistantOrdinal}`;
      state.assistantOrdinal += 1;
      atoms.push({ kind: 'assistant', key, text: delta, status: running ? 'running' : 'complete', messageId });
    }
    return;
  }
  if (type === 'reasoning.available') {
    const text = eventText(event);
    if (text.trim()) atoms.push({ kind: 'thought', key: `live-${runKey}-thought-${eventIndex}`, text });
    return;
  }
  if (isToolEvent(type)) {
    pushLiveTool(atoms, event, runKey, eventIndex);
    return;
  }
  if (type === 'run.failed' || type === 'run.error' || event.error === true) {
    state.failed = true;
    for (let index = 0; index < atoms.length; index += 1) {
      const atom = atoms[index];
      if (atom.kind === 'assistant') atoms[index] = { ...atom, status: 'failed' };
      if (atom.kind === 'tool' && atom.status === 'running') atoms[index] = { ...atom, status: 'failed' };
    }
    const text = eventText(event);
    if (text) atoms.push({ kind: 'error', key: `live-${runKey}-error-${state.errorOrdinal++}`, text, status: 'failed' });
    return;
  }
  if (type === 'run.completed' || type === 'run.cancelled' || type === 'run.interrupted') {
    state.terminal = true;
    for (let index = 0; index < atoms.length; index += 1) {
      const atom = atoms[index];
      if ((atom.kind === 'assistant' || atom.kind === 'tool') && atom.status === 'running') atoms[index] = { ...atom, status: 'complete' };
    }
    const output = field(event, 'output', 'final_response');
    if (output) {
      // The final response also rides the terminal event for clients whose
      // stream missed deltas; it replaces whatever partial text the stream delivered.
      // Hermes reports reasoning after the response it belongs to, so only tools bound the answer.
      const lastToolIndex = atoms.findLastIndex((atom) => atom.kind === 'tool');
      const answerIndex = atoms.findLastIndex((atom, index) => index > lastToolIndex && atom.kind === 'assistant');
      if (answerIndex < 0) {
        atoms.push({ kind: 'assistant', key: `live-${runKey}-assistant-${state.assistantOrdinal++}`, text: output, status: 'complete' });
      } else {
        const answer = atoms[answerIndex];
        if (answer.kind === 'assistant' && answer.text !== output && answer.status !== 'running') {
          atoms[answerIndex] = { ...answer, text: output };
        }
      }
    }
  }
}

function atomStep(atom: LiveAtom & { kind: 'tool' | 'thought' }): WorkStep {
  if (atom.kind === 'thought') return { id: atom.key, kind: 'thought', text: atom.text };
  return { id: atom.key, kind: 'tool', name: atom.name, input: atom.input, output: atom.output, status: atom.status, duration: atom.duration };
}

function buildLive(events: readonly HermesRunEvent[], runId: string | undefined, running: boolean, previous?: LiveCache): LiveCache {
  const keys = events.map(eventKey);
  const runKey = runId ?? 'stream';
  let atoms: LiveAtom[];
  let start = 0;
  let state = { assistantOrdinal: 0, errorOrdinal: 0, failed: false, terminal: false };
  if (previous && previous.runKey === runKey && previous.keys.length <= keys.length && previous.keys.every((key, index) => key === keys[index])) {
    atoms = previous.atoms.map((atom) => ({ ...atom }));
    start = previous.keys.length;
    state = {
      assistantOrdinal: atoms.filter((atom) => atom.kind === 'assistant').length,
      errorOrdinal: atoms.filter((atom) => atom.kind === 'error').length,
      failed: previous.failed,
      terminal: previous.terminal,
    };
  } else {
    atoms = [];
  }
  const seen = new Set<string>();
  for (const event of events.slice(0, start)) {
    const identity = eventTransportIdentity(event);
    if (identity) seen.add(identity);
  }
  for (let index = start; index < events.length; index += 1) {
    const identity = eventTransportIdentity(events[index]);
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    processLiveEvent(atoms, events[index], state, runKey, running, index);
  }
  if (!running && !state.failed) {
    for (let index = 0; index < atoms.length; index += 1) {
      const atom = atoms[index];
      if ((atom.kind === 'assistant' || atom.kind === 'tool') && atom.status === 'running') atoms[index] = { ...atom, status: 'complete' };
    }
  }

  const descriptors: RowDescriptor[] = [];
  for (const atom of atoms) {
    if (atom.kind === 'tool' || atom.kind === 'thought') {
      const step = atomStep(atom);
      const last = descriptors.at(-1);
      if (last?.kind === 'work') descriptors[descriptors.length - 1] = { ...last, steps: [...last.steps, step] };
      else descriptors.push({ key: `live-work-${atom.key}`, kind: 'work', steps: [step] });
    } else {
      descriptors.push({ key: atom.key, kind: atom.kind, text: atom.text, status: atom.status });
    }
  }
  return { keys, runKey, atoms, rows: descriptorsToRows(descriptors, previous?.rows), failed: state.failed, terminal: state.terminal };
}

function withoutReplay(history: HistoryCache, live: LiveCache, input: TranscriptProjectionInput): readonly FlatRow[] {
  const currentRunFinal = input.runStartedAt !== undefined
    && history.lastAssistantTimestamp !== undefined
    && toSeconds(history.lastAssistantTimestamp) >= toSeconds(input.runStartedAt);
  if (!input.running && currentRunFinal && input.runOutput && history.lastAssistantText === input.runOutput) return history.rows;
  const liveRows = [...live.rows];
  const lastAssistantIndex = liveRows.findLastIndex((row) => row.kind === 'assistant');
  const lastAssistant = lastAssistantIndex >= 0 ? liveRows[lastAssistantIndex] : undefined;
  if (lastAssistant?.kind === 'assistant' && history.lastAssistantText && lastAssistant.text === history.lastAssistantText) {
    const hasExplicitMatch = live.atoms.some((atom) => atom.kind === 'assistant' && atom.messageId && atom.messageId === history.lastAssistantId);
    const currentRunFinal = input.runStartedAt !== undefined
      && history.lastAssistantTimestamp !== undefined
      && toSeconds(history.lastAssistantTimestamp) >= toSeconds(input.runStartedAt) - 1;
    if (live.terminal && (hasExplicitMatch || currentRunFinal)) return history.rows;
    if (hasExplicitMatch || (live.terminal && history.rows.at(-1)?.kind === 'assistant')) liveRows.splice(lastAssistantIndex, 1);
  }
  return [...history.rows, ...liveRows];
}

// A created run reports `queued` and Hermes never streams `run.started`, so queued means working.
function activityPhase(status: HermesRunState | undefined): ActivityPhase {
  if (status === 'waiting_for_approval') return 'approval';
  if (status === 'stopping') return 'stopping';
  return 'working';
}

function settledStatus(body: readonly FlatRow[], runStatus: HermesRunState | undefined): ActivityStatus {
  if (runStatus === 'cancelled' || runStatus === 'interrupted') return 'stopped';
  if (runStatus === 'failed' || body.some((row) => row.kind === 'error')) return 'failed';
  return 'complete';
}

/**
 * Fold one turn: the user message, then a single activity row holding every
 * tool call, thought, and interim note, then errors and the final answer.
 * Assistant text after the last tool call stays visible; while running it may
 * still turn into a note once another tool starts.
 */
function groupTurn(user: TranscriptMessageRow | undefined, body: readonly FlatRow[], current: boolean, input: TranscriptProjectionInput, previous: ReadonlyMap<string, TranscriptRow>): TranscriptRow[] {
  // Only tool calls mark text as interim: Hermes reports reasoning after the answer it produced.
  const lastWork = body.findLastIndex((row) => row.kind === 'work' && row.steps.some((step) => step.kind === 'tool'));
  const steps: TranscriptStep[] = [];
  const visible: TranscriptMessageRow[] = [];
  for (const [index, row] of body.entries()) {
    if (row.kind === 'work') steps.push(...row.steps);
    else if (row.kind === 'assistant' && index < lastWork) steps.push({ id: `note-${row.id}`, kind: 'note', text: row.text });
    else visible.push(row);
  }
  const running = current && input.running;
  const runStatus = current ? input.runStatus : undefined;
  const status = running ? 'running' : settledStatus(body, runStatus);
  // A settled turn without steps only needs a row when it ended badly.
  if (!running && !steps.length && status !== 'stopped' && !(current && runStatus === 'failed')) return user ? [user, ...visible] : [...visible];

  const startedAt = (current ? input.runStartedAt : undefined) ?? user?.timestamp;
  const endedAt = running ? undefined : body.findLast((row): row is TranscriptMessageRow => row.kind !== 'work' && row.timestamp !== undefined)?.timestamp ?? (current ? input.runEndedAt : undefined);
  const id = `activity-${user?.id ?? 'leading'}`;
  const prior = previous.get(id);
  const stable = stableSteps(steps, prior?.kind === 'activity' ? prior.steps : []);
  const phase = running ? activityPhase(runStatus) : undefined;
  const activity: TranscriptActivityRow = prior?.kind === 'activity' && prior.status === status && prior.phase === phase && prior.startedAt === startedAt && prior.endedAt === endedAt && sameSteps(prior.steps, stable)
    ? prior
    : { id, kind: 'activity', status, phase, steps: stable, startedAt, endedAt };
  return user ? [user, activity, ...visible] : [activity, ...visible];
}

function groupTurns(rows: readonly FlatRow[], input: TranscriptProjectionInput, previous: readonly TranscriptRow[]): readonly TranscriptRow[] {
  const previousById = new Map<string, TranscriptRow>();
  for (const row of previous) if (row.kind === 'activity') previousById.set(row.id, row);
  const output: TranscriptRow[] = [];
  let cursor = 0;
  while (cursor < rows.length) {
    const head = rows[cursor];
    const user = head.kind === 'user' ? head : undefined;
    const bodyStart = user ? cursor + 1 : cursor;
    const next = rows.findIndex((row, index) => index >= bodyStart && row.kind === 'user');
    const end = next < 0 ? rows.length : next;
    output.push(...groupTurn(user, rows.slice(bodyStart, end), end === rows.length, input, previousById));
    cursor = end;
  }
  return output;
}

export function createTranscriptProjector(): TranscriptProjector {
  let historyCache: HistoryCache | undefined;
  let liveCache: LiveCache | undefined;
  let lastRows: readonly TranscriptRow[] = [];
  let lastHistoryInput: readonly HermesMessage[] | undefined;
  let lastEvents: readonly HermesRunEvent[] | undefined;
  let lastRunning: boolean | undefined;
  let lastRunId: string | undefined;

  return (input) => {
    if (input.history !== lastHistoryInput || historyCache?.keys.length !== input.history.length) {
      historyCache = buildHistory(input.history, historyCache);
      lastHistoryInput = input.history;
    }
    const history = historyCache ?? buildHistory(input.history);
    if (input.events !== lastEvents || input.running !== lastRunning || input.runId !== lastRunId || liveCache?.keys.length !== input.events.length) {
      liveCache = buildLive(input.events, input.runId, input.running, liveCache);
      lastEvents = input.events;
      lastRunning = input.running;
      lastRunId = input.runId;
    }
    const live = liveCache ?? buildLive(input.events, input.runId, input.running);
    const rows = groupTurns(withoutReplay(history, live, input), input, lastRows);
    if (rows.length === lastRows.length && rows.every((row, index) => row === lastRows[index])) return lastRows;
    lastRows = rows;
    return rows;
  };
}

