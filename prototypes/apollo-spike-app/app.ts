// PROTOTYPE. Apollo on Exact: pairs with an Apollo connector, lists Hermes threads, and streams
// runs. Apollo's own transcript projector and run-state helpers are reused unchanged (copied in
// by tools/sync-apollo.sh), so the view is the only new part.
import type { Answer, Result, Sources, Storage, Store } from './app.contract.d.ts';
import { createTranscriptProjector, type TranscriptRow } from './apollo/features/relay/transcript.ts';
import { currentApproval, isRunActive, statusAfterEvent } from './apollo/lib/run-state.ts';
import { normalizeEndpoint } from './apollo/lib/endpoint.ts';
import type { HermesMessage, HermesRunEvent, HermesRunState, HermesRunStatus } from './apollo/lib/types.ts';

const SECRET = 'apollo.credential';
const RUNS = 'app:/data/runs.json';
export const appId = 'com.matthewchisolm.apollo.exactspike';
// `https:` admits whatever connector the pairing link names; loopback http is tools/fixture.mjs.
export const grants = ['net.fetch https:', 'net.fetch http://127.0.0.1:19111', `secret.keep ${SECRET}`, `fs.read ${RUNS}`, `fs.write ${RUNS}`].join('\n');

type Thread = Result<'transcript'>;
type Row = Thread['rows'][number];
type Json = Record<string, unknown>;
type Credential = { endpoint: string; token: string; label: string };

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Unpaired extends Error {}

async function credential(store: Store): Promise<Credential> {
  const raw = await store.get(SECRET);
  if (!raw) throw new Unpaired('Not paired');
  return JSON.parse(raw) as Credential;
}

async function api(store: Store, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Json> {
  const { endpoint, token } = await credential(store);
  const res = await fetch(endpoint + path, {
    method: init.method ?? 'GET',
    exactTimeout: 20000,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  } as RequestInit);
  const json = (await res.json().catch(() => ({}))) as Json;
  if (res.status === 401) throw new Error('This phone was unpaired from the connector. Pair it again.');
  if (!res.ok) throw new Error(str((json.error as Json | undefined)?.message) ?? `HTTP ${res.status}`);
  return json;
}

// Runs this app started, by session, so a relaunch or a return from the background picks the
// stream back up. Apollo keeps the same map in its runtime state.
let runs: Record<string, string> | undefined;
async function activeRuns(storage: Storage) {
  if (runs) return runs;
  const bytes = await storage.fs.readFile(RUNS).catch(() => null);
  try { runs = bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>) : {}; } catch { runs = {}; }
  return runs;
}
async function setRun(storage: Storage, sessionId: string, runId: string | undefined) {
  const map = await activeRuns(storage);
  if (runId) map[sessionId] = runId; else delete map[sessionId];
  await storage.fs.atomicWriteFile(RUNS, new TextEncoder().encode(JSON.stringify(map))).catch(() => {});
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

// A GFM pipe table becomes a grid, since `markup="markdown"` draws one as its source. Fenced code
// is never searched for tables. Adapted from Exact's apps/agents.
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cellsOf = (line: string) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
function parts(body: string): Row['parts'] {
  const lines = body.split('\n'), out: Row['parts'] = [];
  let text: string[] = [], fence = '';
  const flush = () => { if (text.join('\n').trim()) out.push({ key: `p${out.length}`, table: false, text: text.join('\n'), rows: [] }); text = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, open = /^\s*(```|~~~)/.exec(line)?.[1];
    if (open && (!fence || fence === open)) fence = fence ? '' : open;
    const next = lines[i + 1];
    if (fence || !line.includes('|') || next === undefined || !DELIMITER.test(next)) { text.push(line); continue; }
    const head = cellsOf(line), aligns = cellsOf(next).map((d) => (d.endsWith(':') ? (d.startsWith(':') ? 'center' : 'right') : 'left'));
    const body: string[][] = [];
    for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) body.push(cellsOf(lines[i]!));
    i--;
    flush();
    const row = (cells: string[], r: number, head: boolean) => ({ key: `r${r}`, head, cells: aligns.map((align, c) => ({ key: `c${c}`, text: cells[c] ?? '', align, first: c === 0 })) });
    out.push({ key: `p${out.length}`, table: true, text: '', rows: [row(head, 0, true), ...body.map((cells, r) => row(cells, r + 1, false))] });
  }
  flush();
  return out;
}

function toRow(row: TranscriptRow): Row {
  if (row.kind !== 'activity') return { id: row.id, kind: row.kind, text: row.text, parts: row.kind === 'assistant' ? parts(row.text) : [], status: row.status ?? '', summary: '', running: row.status === 'running', steps: [] };
  const tools = row.steps.filter((s) => s.kind === 'tool');
  const last = tools.at(-1);
  const running = row.status === 'running';
  const summary = running
    ? row.phase === 'approval' ? 'Waiting for approval' : last ? `${last.name} ${last.input}`.trim() : 'Working'
    : `${tools.length === 0 ? 'Thought' : `Used ${tools.length} tool${tools.length === 1 ? '' : 's'}`}${row.status === 'failed' ? ', failed' : row.status === 'stopped' ? ', stopped' : ''}`;
  return {
    id: row.id, kind: 'activity', text: '', parts: [], status: row.status, summary, running,
    steps: row.steps.map((s) => s.kind === 'tool'
      ? { key: s.id, kind: 'tool', label: s.name, detail: [s.input, s.output].filter(Boolean).join(' → '), running: s.status === 'running', failed: s.status === 'failed' }
      : { key: s.id, kind: s.kind, label: s.kind === 'thought' ? 'Thought' : 'Note', detail: s.text, running: false, failed: false }),
  };
}

const emptyThread: Thread = {
  title: '', rows: [], runId: '', status: '', active: false, ended: false, error: '',
  approvalId: '', approvalTitle: '', approvalCommand: '', approvalReason: '',
};

async function history(store: Store, sessionId: string) {
  const [session, list] = await Promise.all([api(store, `/api/sessions/${encodeURIComponent(sessionId)}`), api(store, `/api/sessions/${encodeURIComponent(sessionId)}/messages`)]);
  return { title: str((session.session as Json | undefined)?.title) || 'New thread', messages: ((list.data as Json[] | undefined) ?? []).map(parseMessage) };
}

// History alone, or history plus the session's active run as a stream: each chunk of the run's
// events is parsed and mapped through Apollo's projector, and commits as the next answer.
async function transcript(sessionId: string, store: Store, storage: Storage): Promise<Thread> {
  if (!sessionId) return emptyThread;
  try {
    const project = createTranscriptProjector();
    const { title, messages } = await history(store, sessionId);
    const runId = (await activeRuns(storage))[sessionId];
    let run = runId ? parseRun(await api(store, `/v1/runs/${encodeURIComponent(runId)}`).catch(() => ({ run_id: runId, status: 'unknown' }))) : undefined;
    if (!runId || !run || !isRunActive(run.status)) {
      if (runId) await setRun(storage, sessionId, undefined);
      return { ...emptyThread, title, rows: project({ history: messages, events: [], running: false }).map(toRow) };
    }
    const { endpoint, token } = await credential(store);
    const events: HermesRunEvent[] = [];
    const seen = new Set<string>();
    let closed = false, error = '';
    const snapshot = (): Thread => {
      const current = run!;
      const running = isRunActive(current.status) && !closed;
      const approval = running ? currentApproval(events, current) : undefined;
      const command = str(approval?.command) ?? str(approval?.preview);
      const rows = project({ history: messages, events, runId, runStartedAt: current.createdAt, runEndedAt: current.updatedAt, runStatus: current.status, runOutput: current.output, running });
      return {
        ...emptyThread, title, rows: rows.map(toRow), runId, status: current.status, active: running, ended: !running, error,
        ...(approval && command ? { approvalId: str(approval.request_id) ?? approval.requestId ?? '', approvalTitle: approval.tool ? `Allow ${approval.tool}?` : 'Allow this command?', approvalCommand: command, approvalReason: approval.description ?? '' } : {}),
      };
    };
    const take = (data: string) => {
      const event = parseEvent(JSON.parse(data) as Json);
      const id = str(event.event_id);
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      events.push(event);
      run = statusAfterEvent(run!, event);
      if (event.event === 'run.completed') run = { ...run, output: str(event.output) ?? str(event.final_response) ?? run.output };
    };
    // Exact coalesces SSE messages that arrive faster than it commits, losing deltas, so the
    // connector is asked for the same frames as bytes, which Exact never drops.
    const decoder = new TextDecoder();
    let buffer = '';
    return fetch(`${endpoint}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' },
      exactStream: (e: { type: string; data?: unknown; kind?: string; message?: string }) => {
        if (e.type === 'error') {
          closed = true;
          if (e.kind !== 'Network') error = e.message ?? 'The event stream failed';
        } else if (e.data instanceof ArrayBuffer) {
          buffer += decoder.decode(e.data, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (data) try { take(data); } catch { /* a malformed frame is skipped, as Apollo does */ }
          }
        }
        return snapshot();
      },
    } as RequestInit) as unknown as Promise<Thread>;
  } catch (e) {
    return { ...emptyThread, error: message(e), ended: true };
  }
}

function ago(seconds: number | undefined, now: number) {
  if (!seconds) return '';
  const s = Math.max(0, now / 1000 - seconds);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function start(store: Store, storage: Storage, sessionId: string, input: string) {
  const run = await api(store, '/v1/runs', { method: 'POST', body: { input, session_id: sessionId }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
  await setRun(storage, sessionId, String(run.run_id));
}

const sources: Sources = {
  account: async (_args, store) => {
    try { const c = await credential(store); return { paired: true, label: c.label, endpoint: c.endpoint }; }
    catch { return { paired: false, label: '', endpoint: '' }; }
  },
  pair: async ([link], store) => {
    try {
      const url = new URL(link.trim());
      const host = url.searchParams.get('host');
      const token = new URLSearchParams(url.hash.slice(1)).get('token');
      if (!host || !token) throw new Error('That is not an Apollo pairing link.');
      const endpoint = normalizeEndpoint(host);
      const descriptor = (await (await fetch(`${endpoint}/.well-known/apollo/agent`, { exactTimeout: 15000 } as RequestInit)).json()) as Json;
      const path = str((descriptor.pairing as Json | undefined)?.exchange_path) ?? '/v1/pair/exchange';
      const res = await fetch(endpoint + path, { method: 'POST', exactTimeout: 15000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, device_name: 'Apollo on Exact' }) } as RequestInit);
      const body = (await res.json().catch(() => ({}))) as Json;
      if (!res.ok) throw new Error(str((body.error as Json | undefined)?.message) ?? 'The link expired or was already used. Make a new one.');
      await store.set(SECRET, JSON.stringify({ endpoint, token: String(body.access_token), label: str(descriptor.label) ?? 'Hermes' } satisfies Credential));
      return { error: '' };
    } catch (e) { return { error: message(e) }; }
  },
  unpair: async (_args, store) => { await store.forget(SECRET); runs = {}; return { error: '' }; },
  listSessions: async ([, , , now], store, storage) => {
    try {
      const [{ data }, active] = await Promise.all([api(store, '/api/sessions?limit=200'), activeRuns(storage)]);
      const rows = ((data as Json[] | undefined) ?? []).filter((s) => !s.hidden && !s.archived)
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (num(b.last_active) ?? num(b.started_at) ?? 0) - (num(a.last_active) ?? num(a.started_at) ?? 0));
      return { error: '', rows: rows.map((s) => ({ id: String(s.id), title: str(s.title) || 'Untitled', preview: str(s.preview) ?? '', time: ago(num(s.last_active) ?? num(s.started_at), now), running: !!active[String(s.id)] })) };
    } catch (e) { return { error: e instanceof Unpaired ? '' : message(e), rows: [] }; }
  },
  transcript: ([sessionId], store, storage) => transcript(sessionId, store, storage),
  createThread: async ([input], store, storage) => {
    try {
      const id = crypto.randomUUID();
      await api(store, '/api/sessions', { method: 'POST', body: { id, title: input.split('\n')[0]!.slice(0, 72) } });
      await start(store, storage, id, input);
      return { id, error: '' };
    } catch (e) { return { id: '', error: message(e) }; }
  },
  startRun: async ([sessionId, input], store, storage) => {
    try { await start(store, storage, sessionId, input); return { error: '' }; } catch (e) { return { error: message(e) }; }
  },
  stopRun: async ([runId], store) => {
    try { await api(store, `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }); return { error: '' }; } catch (e) { return { error: message(e) }; }
  },
  answerApproval: async ([runId, requestId, choice], store) => {
    try {
      await api(store, `/v1/runs/${encodeURIComponent(runId)}/approval`, { method: 'POST', body: { choice, ...(requestId ? { request_id: requestId } : {}) } });
      return { error: '' };
    } catch (e) { return { error: message(e) }; }
  },
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
