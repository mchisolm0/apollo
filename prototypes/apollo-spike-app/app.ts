// PROTOTYPE, throwaway. Apollo's session screen on Exact: the data seam talks to Apollo's real
// connector (tools/fixture.mjs runs it over a fake Hermes) and reuses Apollo's own transcript
// projector and run-state helpers unchanged, so only the view is new.
import type { Answer, Result, Sources } from './app.contract.d.ts';
import { createTranscriptProjector, type TranscriptRow } from './apollo/features/relay/transcript.ts';
import { currentApproval, isRunActive, statusAfterEvent } from './apollo/lib/run-state.ts';
import type { HermesMessage, HermesRunEvent, HermesRunState, HermesRunStatus } from './apollo/lib/types.ts';

const CONNECTOR = 'http://127.0.0.1:19111';
const FIXTURE = 'http://127.0.0.1:19112';
// Read run events as a byte stream (lossless) instead of Exact's SSE reader (coalesces).
const BYTES = true;
export const appId = 'com.matthewchisolm.apollo.exactspike';
export const grants = [`net.fetch ${CONNECTOR}`, `net.fetch ${FIXTURE}`].join('\n');

type Thread = Result<'transcript'>;
type Row = Thread['rows'][number];
type Json = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
// The last run's counters, kept after it settles so a short run can be read afterwards.
let lastRun = '';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The fixture stands in for pairing: it hands out a token it already exchanged.
let credential: Promise<{ endpoint: string; token: string }> | undefined;
function auth() {
  credential ??= fetch(`${FIXTURE}/__spike/credential`).then((r) => r.json()).catch((e) => { credential = undefined; throw e; });
  return credential;
}

async function api(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Json> {
  const { endpoint, token } = await auth();
  const res = await fetch(endpoint + path, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(str((json.error as Json | undefined)?.message) ?? `HTTP ${res.status}`);
  return json;
}

// The same mapping as Apollo's hermes-client parseMessage / parseEvent / parseRun.
const parseMessage = (v: Json): HermesMessage => ({
  id: str(v.id), sequence: num(v.id), sessionId: str(v.session_id), role: str(v.role) ?? 'system', content: str(v.content),
  toolCallId: str(v.tool_call_id), toolName: str(v.tool_name), toolCalls: Array.isArray(v.tool_calls) ? (v.tool_calls as Json[]) : undefined,
  timestamp: num(v.timestamp), finishReason: str(v.finish_reason), reasoning: str(v.reasoning), reasoningContent: str(v.reasoning_content), displayKind: str(v.display_kind),
});
const parseEvent = (v: Json): HermesRunEvent => ({ ...v, event: String(v.event), runId: str(v.run_id), timestamp: num(v.timestamp), text: str(v.text), tool: str(v.tool), preview: str(v.preview) });
const parseRun = (v: Json): HermesRunStatus => ({
  runId: String(v.run_id), status: (str(v.status) ?? 'unknown') as HermesRunState, sessionId: str(v.session_id), output: str(v.output),
  error: str(v.error), createdAt: num(v.created_at), updatedAt: num(v.updated_at), approval: v.approval as HermesRunStatus['approval'],
});

function toRow(row: TranscriptRow): Row {
  if (row.kind !== 'activity') return { id: row.id, kind: row.kind, text: row.text, status: row.status ?? '', summary: '', steps: [] };
  const tools = row.steps.filter((s) => s.kind === 'tool').length;
  return {
    id: row.id, kind: 'activity', text: '', status: row.status,
    summary: `${tools} tool${tools === 1 ? '' : 's'} · ${row.phase ?? row.status}`,
    steps: row.steps.map((s) => s.kind === 'tool'
      ? { key: s.id, kind: 'tool', label: s.name, detail: [s.input, s.output].filter(Boolean).join(' → '), running: s.status === 'running', failed: s.status === 'failed' }
      : { key: s.id, kind: s.kind, label: s.kind === 'thought' ? 'Thought' : 'Note', detail: s.text, running: false, failed: false }),
  };
}

const emptyThread: Thread = {
  title: '', rows: [], runId: '', status: '', active: false, ended: false, error: '',
  approvalId: '', approvalTitle: '', approvalCommand: '', approvalReason: '', events: 0, deltas: 0, coalesced: 0, lastRun: '',
};

function thread(title: string, rows: readonly TranscriptRow[], extra: Partial<Thread> = {}): Thread {
  return { ...emptyThread, title, rows: rows.map(toRow), lastRun, ...extra };
}

async function history(sessionId: string) {
  const [session, list] = await Promise.all([api(`/api/sessions/${encodeURIComponent(sessionId)}`), api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)]);
  return { title: str((session.session as Json | undefined)?.title) ?? 'Thread', messages: ((list.data as Json[] | undefined) ?? []).map(parseMessage) };
}

// History alone, or history plus one run's live events as a stream: each SSE message is mapped
// through Apollo's projector and commits as the resource's next answer.
async function transcript(sessionId: string, runId: string): Promise<Thread> {
  if (!sessionId) return emptyThread;
  const project = createTranscriptProjector();
  try {
    const { title, messages } = await history(sessionId);
    if (!runId) return thread(title, project({ history: messages, events: [], running: false }));
    const { endpoint, token } = await auth();
    let run = parseRun(await api(`/v1/runs/${encodeURIComponent(runId)}`));
    const events: HermesRunEvent[] = [];
    const seen = new Set<string>();
    let deltas = 0, coalesced = 0, closed = false, error = '';
    const snapshot = () => {
      const running = isRunActive(run.status) && !closed;
      const approval = currentApproval(events, run);
      const command = str(approval?.command) ?? str(approval?.preview);
      return thread(title, project({ history: messages, events, runId, runStartedAt: run.createdAt, runEndedAt: run.updatedAt, runStatus: run.status, runOutput: run.output, running }), {
        runId, status: run.status, active: running, ended: !running, error, events: events.length, deltas, coalesced,
        ...(approval && command ? { approvalId: str(approval.request_id) ?? approval.requestId ?? '', approvalTitle: approval.tool ? `Allow ${approval.tool}?` : 'Allow this command?', approvalCommand: command, approvalReason: approval.description ?? '' } : {}),
      });
    };
    const take = (data: string) => {
      const event = parseEvent(JSON.parse(data) as Json);
      const id = str(event.event_id);
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      events.push(event);
      if (event.event === 'message.delta') deltas++;
      run = statusAfterEvent(run, event);
      if (event.event === 'run.completed') run = { ...run, output: str(event.output) ?? run.output };
    };
    // Exact coalesces SSE messages that arrive faster than they commit (a storm of 2,000 deltas
    // kept 785), so BYTES asks for the body as bytes, which Exact never drops, and splits the
    // SSE frames here. Real Hermes always answers text/event-stream: the connector would relabel it.
    const decoder = new TextDecoder();
    let buffer = '';
    return fetch(`${endpoint}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Authorization: `Bearer ${token}`, ...(BYTES ? { Accept: 'application/octet-stream' } : {}) },
      exactStream: (e: { type: string; data?: unknown; coalesced?: number; kind?: string; message?: string }) => {
        coalesced += e.coalesced ?? 0;
        if (e.type === 'error') {
          closed = true;
          if (e.kind !== 'Network') error = e.message ?? 'The event stream failed';
        } else if (e.data instanceof ArrayBuffer) {
          buffer += decoder.decode(e.data, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (data) take(data);
          }
        } else if (typeof e.data === 'string' && e.data) take(e.data);
        lastRun = `last run ${run.status} (${BYTES ? 'bytes' : 'sse'}): ${events.length} events, ${deltas} deltas, ${coalesced} coalesced`;
        return snapshot();
      },
    } as RequestInit) as unknown as Promise<Thread>;
  } catch (e) {
    return { ...emptyThread, error: message(e), ended: true };
  }
}

const sources: Sources = {
  listSessions: async () => {
    const { data } = await api('/api/sessions?limit=200');
    return ((data as Json[] | undefined) ?? []).map((s) => ({ id: String(s.id), title: str(s.title) ?? 'Untitled', preview: str(s.preview) ?? '' }));
  },
  transcript: ([sessionId, runId]) => transcript(sessionId, runId),
  startRun: async ([sessionId, input]) => {
    try {
      const run = await api('/v1/runs', { method: 'POST', body: { input, session_id: sessionId }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
      return { runId: String(run.run_id), error: '' };
    } catch (e) { return { runId: '', error: message(e) }; }
  },
  stopRun: async ([runId]) => {
    try { await api(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }); return { error: '' }; } catch (e) { return { error: message(e) }; }
  },
  answerApproval: async ([runId, requestId, choice]) => {
    try {
      await api(`/v1/runs/${encodeURIComponent(runId)}/approval`, { method: 'POST', body: { choice, ...(requestId ? { request_id: requestId } : {}) } });
      return { error: '' };
    } catch (e) { return { error: message(e) }; }
  },
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
