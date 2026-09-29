import { eventTransportIdentity } from '../../lib/run-state.ts';
import type { HermesMessage, HermesRunEvent } from '../../lib/types';

export type TranscriptStatus = 'running' | 'complete' | 'failed';

export interface TranscriptTool {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly status: TranscriptStatus;
}

export interface TranscriptMessageRow {
  readonly id: string;
  readonly kind: 'user' | 'assistant' | 'error';
  readonly text: string;
  readonly status?: TranscriptStatus;
}

export interface TranscriptWorkRow {
  readonly id: string;
  readonly kind: 'work';
  readonly summary: string;
  readonly status: TranscriptStatus;
  readonly items: readonly TranscriptTool[];
}

export type TranscriptRow = TranscriptMessageRow | TranscriptWorkRow;

export interface TranscriptProjectionInput {
  readonly history: readonly HermesMessage[];
  readonly events: readonly HermesRunEvent[];
  readonly runId?: string;
  /** Unix seconds or milliseconds, used to distinguish an older equal answer. */
  readonly runStartedAt?: number;
  readonly runOutput?: string;
  readonly running: boolean;
}

export type TranscriptProjector = (input: TranscriptProjectionInput) => readonly TranscriptRow[];

type MessageDescriptor = {
  readonly key: string;
  readonly kind: 'user' | 'assistant' | 'error';
  readonly text: string;
  readonly status: TranscriptStatus;
};

type ToolDescriptor = TranscriptTool & { readonly key: string };

type WorkDescriptor = {
  readonly key: string;
  readonly kind: 'work';
  readonly summary: string;
  readonly status: TranscriptStatus;
  readonly items: readonly ToolDescriptor[];
};

type RowDescriptor = MessageDescriptor | WorkDescriptor;

type HistoryCache = {
  readonly keys: readonly string[];
  readonly rows: readonly TranscriptRow[];
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
      id: string;
      name: string;
      text: string;
      status: TranscriptStatus;
      identity?: string;
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
  readonly rows: readonly TranscriptRow[];
  readonly failed: boolean;
  readonly terminal: boolean;
};

const EMPTY = '';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function field(value: HermesRunEvent | Record<string, unknown>, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const candidate = stringValue(value[name]);
    if (candidate) return candidate;
  }
  return undefined;
}

function messageText(message: HermesMessage): string {
  return message.content ?? message.reasoningContent ?? message.reasoning ?? EMPTY;
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
  const calls = message.toolCalls?.map((call) => `${toolIdentity(call) ?? ''}:${toolName(call)}:${toolText(call)}`).join('|') ?? '';
  return [message.id ?? `index-${index}`, message.role, message.content, message.reasoningContent, message.reasoning, message.toolCallId, message.toolName, calls].map((value) => value ?? '').join('\u001f');
}

function toolName(value: Record<string, unknown>, fallback = 'tool'): string {
  return field(value, 'name', 'tool', 'tool_name', 'toolName') ?? fallback;
}

function toolText(value: Record<string, unknown>): string {
  return field(value, 'text', 'summary', 'preview', 'description', 'message') ?? EMPTY;
}

function toolIdentity(value: Record<string, unknown>): string | undefined {
  return field(value, 'tool_call_id', 'toolCallId', 'call_id', 'callId', 'id');
}

function workStatus(items: readonly { status: TranscriptStatus }[]): TranscriptStatus {
  if (items.some((item) => item.status === 'failed')) return 'failed';
  if (items.some((item) => item.status === 'running')) return 'running';
  return 'complete';
}

export function friendlyToolName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortText(text: string): string {
  const compact = text.trim().replace(/\s+/g, ' ');
  return compact.length > 100 ? `${compact.slice(0, 97)}…` : compact;
}

function workSummary(items: readonly { name: string; text: string; status: TranscriptStatus }[]): string {
  const running = items.findLast((item) => item.status === 'running');
  if (running) return shortText(running.text) ? `Running ${shortText(running.text)}` : `Running ${friendlyToolName(running.name)}`;
  if (items.some((item) => item.status === 'failed')) return `Failed ${friendlyToolName(items.findLast((item) => item.status === 'failed')?.name ?? 'tool')}`;
  return items.length === 1 ? `Completed ${friendlyToolName(items[0].name)}` : `${items.length} tools completed`;
}

function descriptorsToRows(descriptors: readonly RowDescriptor[], previous: readonly TranscriptRow[] = []): readonly TranscriptRow[] {
  const previousByKey = new Map<string, TranscriptRow>();
  for (const row of previous) previousByKey.set(row.id, row);

  return descriptors.map((descriptor) => {
    const id = descriptor.key;
    const prior = previousByKey.get(id);
    if (descriptor.kind === 'work') {
      if (prior?.kind === 'work' && sameWork(prior, descriptor)) return prior;
      const priorItems = prior?.kind === 'work' ? prior.items : [];
      const items = descriptor.items.map((item, index) => {
        const priorItem = priorItems[index];
        if (priorItem && priorItem.id === item.id && priorItem.name === item.name && priorItem.text === item.text && priorItem.status === item.status) {
          return priorItem;
        }
        return { id: item.id, name: item.name, text: item.text, status: item.status } satisfies TranscriptTool;
      });
      return { id, kind: 'work', summary: descriptor.summary, status: descriptor.status, items } satisfies TranscriptWorkRow;
    }
    if (prior?.kind === descriptor.kind && prior.text === descriptor.text && prior.status === descriptor.status) return prior;
    return { id, kind: descriptor.kind, text: descriptor.text, status: descriptor.status } satisfies TranscriptMessageRow;
  });
}

function sameWork(prior: TranscriptWorkRow, next: WorkDescriptor): boolean {
  if (prior.summary !== next.summary || prior.status !== next.status || prior.items.length !== next.items.length) return false;
  return next.items.every((item, index) => {
    const previous = prior.items[index];
    return previous.id === item.id && previous.name === item.name && previous.text === item.text && previous.status === item.status;
  });
}

function buildHistory(history: readonly HermesMessage[], previous?: HistoryCache): HistoryCache {
  const keys = history.map(historyFingerprint);
  if (previous && previous.keys.length === keys.length && keys.every((key, index) => key === previous.keys[index])) return previous;

  const descriptors: RowDescriptor[] = [];
  const seenToolIds = new Map<string, number>();
  const toolPositions = new Map<string, { descriptorIndex: number; itemIndex: number }>();
  const messageOccurrences = new Map<string, number>();
  const pushTool = (baseKey: string, value: Record<string, unknown>, index: number, status: TranscriptStatus) => {
    const identity = toolIdentity(value);
    if (identity) {
      const position = toolPositions.get(identity);
      if (position) {
        const work = descriptors[position.descriptorIndex];
        if (work?.kind === 'work') {
          const items = [...work.items];
          const existing = items[position.itemIndex];
          if (existing) {
            items[position.itemIndex] = {
              ...existing,
              name: toolName(value, existing.name),
              text: toolText(value) || existing.text,
              status,
            };
            descriptors[position.descriptorIndex] = {
              ...work,
              summary: workSummary(items),
              status: workStatus(items),
              items,
            };
            return;
          }
        }
      }
    }
    const identityCount = identity ? (seenToolIds.get(identity) ?? 0) : 0;
    if (identity) {
      seenToolIds.set(identity, identityCount + 1);
    }
    const id = `history-tool-${identity ?? `${baseKey}-${index}`}-${identityCount}`;
    const item: ToolDescriptor = {
      key: id,
      id,
      name: toolName(value),
      text: toolText(value),
      status,
    };
    const last = descriptors.at(-1);
    if (last?.kind === 'work') {
      const descriptorIndex = descriptors.length - 1;
      descriptors[descriptors.length - 1] = {
        ...last,
        key: last.key,
        summary: workSummary([...last.items, item]),
        status: workStatus([...last.items, item]),
        items: [...last.items, item],
      };
      if (identity) toolPositions.set(identity, { descriptorIndex, itemIndex: last.items.length });
    } else {
      descriptors.push({ key: `history-work-${id}`, kind: 'work', summary: workSummary([item]), status, items: [item] });
      if (identity) toolPositions.set(identity, { descriptorIndex: descriptors.length - 1, itemIndex: 0 });
    }
  };

  let lastAssistantText: string | undefined;
  let lastAssistantId: string | undefined;
  let lastAssistantTimestamp: number | undefined;
  for (const [index, message] of history.entries()) {
    const role = message.role.toLowerCase();
    const text = messageText(message);
    const identity = message.id ?? `index-${index}`;
    const occurrence = messageOccurrences.get(identity) ?? 0;
    messageOccurrences.set(identity, occurrence + 1);
    const key = messageKey(message, index, occurrence);

    if (role === 'tool') {
      pushTool(key, {
        id: message.toolCallId,
        name: message.toolName,
        text,
      }, index, 'complete');
      continue;
    }
    if (role !== 'user' && role !== 'assistant' && role !== 'error') continue;
    const kind: MessageDescriptor['kind'] = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'error';
    if (!text && role !== 'error') {
      if (role === 'assistant' && message.toolCalls) {
        for (const [toolIndex, rawCall] of message.toolCalls.entries()) {
          pushTool(key, rawCall, toolIndex, 'complete');
        }
      }
      continue;
    }
    if (!text) continue;
    const row: MessageDescriptor = { key: `history-${key}`, kind, text, status: statusForMessage(message, kind) };
    descriptors.push(row);
    if (kind === 'assistant') {
      lastAssistantText = text;
      lastAssistantId = message.id;
      lastAssistantTimestamp = message.timestamp;
    }
    if (role === 'assistant' && message.toolCalls) {
      for (const [toolIndex, rawCall] of message.toolCalls.entries()) {
        pushTool(key, rawCall, toolIndex, 'complete');
      }
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

function pushLiveTool(atoms: LiveAtom[], event: HermesRunEvent, runKey: string, ordinal: number): void {
  const name = eventToolName(event);
  const identity = eventIdentity(event);
  const transition = event.error ? 'fail' : toolTransition(eventType(event));
  const existingIndex = matchingTool(atoms, identity, name, transition !== 'start');
  if (existingIndex >= 0) {
    const existing = atoms[existingIndex];
    if (existing.kind !== 'tool') return;
    const text = eventText(event);
    atoms[existingIndex] = {
      ...existing,
      name: name === 'tool' ? existing.name : name,
      text: text || existing.text,
      status: transition === 'fail' ? 'failed' : transition === 'complete' ? 'complete' : transition === 'start' ? existing.status : existing.status,
    };
    return;
  }
  const status: TranscriptStatus = transition === 'start' ? 'running' : transition === 'fail' ? 'failed' : 'complete';
  const id = `live-${runKey}-tool-${identity ?? ordinal}`;
  atoms.push({ kind: 'tool', key: id, id, identity, name, text: eventText(event), status });
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
      if (atom.kind === 'assistant' && atom.status === 'running') atoms[index] = { ...atom, status: 'complete' };
      if (atom.kind === 'tool' && atom.status === 'running') atoms[index] = { ...atom, status: 'complete' };
    }
    const output = field(event, 'output', 'final_response');
    if (output) {
      // The final response also rides the terminal event for clients whose
      // stream missed deltas; it replaces whatever partial text the stream delivered.
      const lastToolIndex = atoms.findLastIndex((atom) => atom.kind === 'tool');
      const base = lastToolIndex < 0 ? -1 : lastToolIndex;
      const answerIndex = atoms.findLastIndex((atom, index) => index > base && atom.kind === 'assistant');
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
      if (atom.status === 'running') atoms[index] = { ...atom, status: 'complete' };
    }
  }

  const descriptors: RowDescriptor[] = [];
  for (const atom of atoms) {
    if (atom.kind === 'tool') {
      const item: ToolDescriptor = { key: atom.key, id: atom.id, name: atom.name, text: atom.text, status: atom.status };
      const last = descriptors.at(-1);
      if (last?.kind === 'work') {
        descriptors[descriptors.length - 1] = {
          ...last,
          summary: workSummary([...last.items, item]),
          status: workStatus([...last.items, item]),
          items: [...last.items, item],
        };
      } else {
      descriptors.push({ key: `live-work-${atom.key}`, kind: 'work', summary: workSummary([item]), status: item.status, items: [item] });
      }
    } else {
      descriptors.push({ key: atom.key, kind: atom.kind, text: atom.text, status: atom.status });
    }
  }
  return { keys, runKey, atoms, rows: descriptorsToRows(descriptors, previous?.rows), failed: state.failed, terminal: state.terminal };
}

function seconds(value: number): number {
  return value > 100_000_000_000 ? value / 1000 : value;
}

function withoutReplay(history: HistoryCache, live: LiveCache, input: TranscriptProjectionInput): readonly TranscriptRow[] {
  const currentRunFinal = input.runStartedAt !== undefined
    && history.lastAssistantTimestamp !== undefined
    && seconds(history.lastAssistantTimestamp) >= seconds(input.runStartedAt);
  if (!input.running && currentRunFinal && input.runOutput && history.lastAssistantText === input.runOutput) return history.rows;
  const liveRows = [...live.rows];
  const lastAssistantIndex = liveRows.findLastIndex((row) => row.kind === 'assistant');
  const lastAssistant = lastAssistantIndex >= 0 ? liveRows[lastAssistantIndex] : undefined;
  if (lastAssistant?.kind === 'assistant' && history.lastAssistantText && lastAssistant.text === history.lastAssistantText) {
    const hasExplicitMatch = live.atoms.some((atom) => atom.kind === 'assistant' && atom.messageId && atom.messageId === history.lastAssistantId);
    const currentRunFinal = input.runStartedAt !== undefined
      && history.lastAssistantTimestamp !== undefined
      && seconds(history.lastAssistantTimestamp) >= seconds(input.runStartedAt) - 1;
    if (live.terminal && (hasExplicitMatch || currentRunFinal)) return history.rows;
    if (hasExplicitMatch || (live.terminal && history.rows.at(-1)?.kind === 'assistant')) liveRows.splice(lastAssistantIndex, 1);
  }
  return [...history.rows, ...liveRows];
}

function sameTranscriptItems(previous: readonly TranscriptTool[], next: readonly TranscriptTool[]): boolean {
  return previous.length === next.length && next.every((item, index) => {
    const prior = previous[index];
    return prior.id === item.id && prior.name === item.name && prior.text === item.text && prior.status === item.status;
  });
}

function foldedWorkRow(id: string, items: readonly TranscriptTool[], previous: readonly TranscriptRow[]): TranscriptWorkRow {
  const summary = `Worked through ${items.length} ${items.length === 1 ? 'step' : 'steps'}`;
  const prior = previous.find((row) => row.id === id);
  if (prior?.kind === 'work' && prior.summary === summary && prior.status === workStatus(items) && sameTranscriptItems(prior.items, items)) return prior;
  const priorItems = prior?.kind === 'work' ? prior.items : [];
  const stableItems = items.map((item, index) => {
    const priorItem = priorItems[index];
    return priorItem && priorItem.id === item.id && priorItem.name === item.name && priorItem.text === item.text && priorItem.status === item.status
      ? priorItem
      : item;
  });
  return { id, kind: 'work', summary, status: workStatus(items), items: stableItems };
}

function foldTurn(rows: readonly TranscriptRow[], start: number, end: number, previous: readonly TranscriptRow[]): readonly TranscriptRow[] {
  const assistants = rows
    .slice(start + 1, end)
    .map((row, offset) => row.kind === 'assistant' ? start + 1 + offset : -1)
    .filter((index) => index >= 0);
  if (assistants.length < 2) return rows.slice(start, end);
  const firstAssistant = assistants[0];
  const finalAssistant = assistants.at(-1) ?? firstAssistant;
  if (rows.slice(firstAssistant, finalAssistant + 1).some((row) => row.status === 'running')) return rows.slice(start, end);
  const intermediate = rows.slice(firstAssistant + 1, finalAssistant);
  if (!intermediate.some((row) => row.kind !== 'error')) return rows.slice(start, end);

  const folded: TranscriptRow[] = [rows[start], rows[firstAssistant]];
  let items: TranscriptTool[] = [];
  let part = 0;
  const flush = () => {
    if (!items.length) return;
    folded.push(foldedWorkRow(`fold-${rows[firstAssistant].id}-${rows[finalAssistant].id}-${part++}`, items, previous));
    items = [];
  };
  for (const row of intermediate) {
    if (row.kind === 'error') {
      flush();
      folded.push(row);
      continue;
    }
    if (row.kind === 'work') {
      items.push(...row.items);
      continue;
    }
    items.push({
      id: `fold-${rows[firstAssistant].id}-${rows[finalAssistant].id}-progress-${items.length}`,
      name: 'Progress update',
      text: row.text,
      status: row.status ?? 'complete',
    });
  }
  flush();
  folded.push(rows[finalAssistant], ...rows.slice(finalAssistant + 1, end));
  return folded;
}

function foldFinishedTurns(rows: readonly TranscriptRow[], input: TranscriptProjectionInput, previous: readonly TranscriptRow[] = []): readonly TranscriptRow[] {
  if (!rows.length) return rows;
  const lastUser = rows.findLastIndex((row) => row.kind === 'user');
  const activeTurnStart = input.running ? lastUser : -1;
  const output: TranscriptRow[] = [];
  let cursor = 0;
  while (cursor < rows.length) {
    const user = rows[cursor]?.kind === 'user';
    if (!user) {
      output.push(rows[cursor]);
      cursor += 1;
      continue;
    }
    const end = rows.findIndex((row, index) => index > cursor && row.kind === 'user');
    const turnEnd = end < 0 ? rows.length : end;
    output.push(...(cursor === activeTurnStart ? rows.slice(cursor, turnEnd) : foldTurn(rows, cursor, turnEnd, previous)));
    cursor = turnEnd;
  }
  return output;
}

export function createTranscriptProjector(): TranscriptProjector {
  let historyCache: HistoryCache | undefined;
  let liveCache: LiveCache | undefined;
  let lastRows: readonly TranscriptRow[] | undefined;
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
    const rows = foldFinishedTurns(withoutReplay(history, live, input), input, lastRows);
    if (lastRows && rows.length === lastRows.length && rows.every((row, index) => row === lastRows?.[index])) return lastRows;
    lastRows = rows;
    return rows;
  };
}
