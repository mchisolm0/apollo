// PROTOTYPE. Apollo on Exact: pairs with an Apollo connector, shows Apollo's inbox (Hermes threads
// and cloud cards, with settle), and streams runs. Apollo's own transcript projector, run-state,
// inbox and card modules are reused unchanged (copied in by tools/sync-apollo.sh); the view and
// this data seam are the new parts.
import type { Answer, Result, Sources, Storage, Store } from './app.contract.d.ts';
import type { Card, CardAction, CardResponse } from './apollo/cloud/src/contract.ts';
import { parseCard, parseSnapshot } from './apollo/src/features/cloud/cards.ts';
import { previewLine } from './apollo/src/features/cloud/card-text.ts';
import { buildInboxRows, cardOpenPlan, hermesApprovalTarget, isCardSettled, settleAction, updateSettledCards, type InboxCard, type SettledCards } from './apollo/src/features/cloud/inbox-rows.ts';
import { liveActivityLabel, oneLine, readableOutput, settledActivityLabel, toolVerb } from './apollo/src/features/relay/activity.ts';
import { autoSettleSessionsDue, canSettleSession, deriveSessionInbox, isSessionSnoozed, pruneSnoozedLedger, snoozeSession, unsnoozeSession, type InboxSession } from './apollo/src/features/relay/session-inbox.ts';
import { resolveSnoozePresets } from './apollo/src/features/relay/snooze-presets.ts';
import { selectedSkillNames } from './apollo/src/features/relay/composer-skills.ts';
import { attachmentMessage, MAX_ATTACHMENT_BYTES, splitAttachmentMessage, type Attachment } from './apollo/src/lib/attachments.ts';
import { createTranscriptProjector, type TranscriptRow } from './apollo/src/features/relay/transcript.ts';
import { setClock } from './apollo/clock.ts';
import { normalizeEndpoint } from './apollo/src/lib/endpoint.ts';
import { currentApproval, isRunActive, statusAfterEvent } from './apollo/src/lib/run-state.ts';
import type { HermesMessage, HermesRunEvent, HermesRunState, HermesRunStatus, HermesSession } from './apollo/src/lib/types.ts';

const SECRET = 'apollo.credential';
const STATE = 'app:/data/state.json';
export const appId = 'com.matthewchisolm.apollo.exactspike';
// `https:` admits the connector and cloud the pairing names; loopback http is tools/fixture.mjs.
export const grants = ['net.fetch https:', 'net.fetch http://127.0.0.1:19111', 'net.fetch http://127.0.0.1:19113', `secret.keep ${SECRET}`, `fs.read ${STATE}`, `fs.write ${STATE}`, 'fs.read app:/tmp', 'fs.write app:/tmp', 'device.microphone purpose.microphone', 'device.speech-recognition purpose.recognition'].join('\n');

type Thread = Result<'transcript'>;
type Row = Thread['rows'][number];
type Inbox = Result<'inbox'>;
type Item = Inbox['items'][number];
type CardView = Result<'card'>;
type Json = Record<string, unknown>;
type Credential = { endpoint: string; token: string; label: string; cloud?: { url: string; token: string } };

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

class Unpaired extends Error {}

// ---- Credentials and requests ----

async function credential(store: Store): Promise<Credential> {
  const raw = await store.get(SECRET);
  if (!raw) throw new Unpaired('Not paired');
  return JSON.parse(raw) as Credential;
}

async function request(base: string, token: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Json> {
  const res = await fetch(base + path, {
    method: init.method ?? 'GET',
    exactTimeout: 20000,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  } as RequestInit);
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    const error = json.error as Json | undefined;
    throw Object.assign(new Error(str(error?.message) ?? `HTTP ${res.status}`), { status: res.status, code: str(error?.code), body: json });
  }
  return json;
}

async function api(store: Store, path: string, init?: Parameters<typeof request>[3]) {
  const { endpoint, token } = await credential(store);
  try { return await request(endpoint, token, path, init); }
  catch (e) {
    if ((e as { status?: number }).status === 401) throw new Error('This phone was unpaired from the connector. Pair it again.');
    throw e;
  }
}

// The cloud inbox's device token comes with pairing; an older pairing asks the connector once.
let cloudAsked = false;
async function cloud(store: Store): Promise<Credential['cloud']> {
  const c = await credential(store);
  if (c.cloud || cloudAsked) return c.cloud;
  cloudAsked = true;
  try {
    const body = await request(c.endpoint, c.token, '/v1/apollo/cloud-token', { method: 'POST', body: {} });
    const grant = body.cloud as Json | undefined;
    if (str(grant?.url) && str(grant?.token)) {
      c.cloud = { url: String(grant!.url).replace(/\/$/, ''), token: String(grant!.token) };
      await store.set(SECRET, JSON.stringify(c));
    }
  } catch { /* no cloud configured on this connector: cards stay off */ }
  return c.cloud;
}

// ---- Local state: runs this app started, threads read, cards settled ----

// `recent` is the threads opened last, newest first: the Home Screen's quick actions.
// snoozed: Apollo's local snooze ledger, thread id -> wake time in unix seconds.
// models: the model each thread runs on, as `provider|id`, kept on this phone as Apollo does.
type Local = { runs: Record<string, string>; read: Record<string, number>; cards: Record<string, number>; recent: { id: string; title: string }[]; snoozed: Record<string, number>; models: Record<string, string> };
const fresh = (): Local => ({ runs: {}, read: {}, cards: {}, recent: [], snoozed: {}, models: {} });
let local: Local | undefined;
async function state(storage: Storage): Promise<Local> {
  if (local) return local;
  const bytes = await storage.fs.readFile(STATE).catch(() => null);
  try { local = { ...fresh(), ...(bytes ? JSON.parse(new TextDecoder().decode(bytes)) : {}) }; } catch { local = fresh(); }
  return local!;
}
async function save(storage: Storage) {
  if (local) await storage.fs.atomicWriteFile(STATE, new TextEncoder().encode(JSON.stringify(local))).catch(() => {});
}
const settledCards = (l: Local): SettledCards => new Map(Object.entries(l.cards));

// ---- Hermes parsing, as Apollo's hermes-client does it ----

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
const parseSession = (v: Json): HermesSession => ({
  id: String(v.id), source: str(v.source), model: str(v.model), title: str(v.title), startedAt: num(v.started_at), endedAt: num(v.ended_at),
  endReason: str(v.end_reason), messageCount: num(v.message_count), lastActive: num(v.last_active), parentSessionId: str(v.parent_session_id),
  pinned: bool(v.pinned), archived: bool(v.archived), hidden: bool(v.hidden), preview: str(v.preview),
});

// ---- Inbox ----

function ago(seconds: number | undefined, now: number) {
  if (!seconds) return '';
  const s = Math.max(0, now / 1000 - seconds);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// The last list, so a thread or card screen can answer without asking again.
let sessionsSeen: InboxSession[] = [];
let cardsSeen: Card[] = [];

async function sessionsAndRuns(store: Store, storage: Storage) {
  const l = await state(storage);
  const [list, inbox] = await Promise.all([api(store, '/api/sessions?limit=200'), api(store, '/v1/inbox').catch(() => ({ settled: {}, config: {} }))]);
  const settled = (inbox.settled ?? {}) as Record<string, number | null>;
  const config = (inbox.config ?? {}) as Record<string, { auto_settle?: boolean }>;
  const sessions = ((list.data as Json[] | undefined) ?? []).filter((s) => !s.hidden && !s.archived).map((v) => {
    const s = parseSession(v);
    return { ...s, ...(s.id in settled ? { settledAt: settled[s.id] } : {}), ...(config[s.id] ? { autoSettleDisabled: config[s.id]!.auto_settle === false } : {}) };
  });
  const runs: Record<string, HermesRunStatus> = {};
  await Promise.all(Object.entries(l.runs).map(async ([sessionId, runId]) => {
    try {
      const run = { ...parseRun(await api(store, `/v1/runs/${encodeURIComponent(runId)}`)), sessionId };
      runs[runId] = run;
      if (!isRunActive(run.status)) delete l.runs[sessionId];
    } catch { delete l.runs[sessionId]; }
  }));
  await save(storage);
  return { sessions, runs };
}

async function settleThreads(store: Store, settled: Record<string, number | null>) {
  await api(store, '/v1/inbox', { method: 'PATCH', body: { importOnly: false, settled } });
}

const picksOf = (card: Card) => (card.picks ?? []).map((p) => ({ n: p.n, text: p.text, sub: p.sub ?? '', url: p.url ?? '', done: p.done }));
const button = (a: CardAction) => ({ id: a.id, label: a.label, style: a.style ?? 'default', input: a.input === 'text', url: a.url ?? '' });
const noExtras = { picks: [], meta: [], summary: '', snooze: false } satisfies Pick<Item, 'picks' | 'meta' | 'summary' | 'snooze'>;

// The morning card as Apollo's first inbox row: its day, calendar line, up to three picks and its
// actions, then "Working on these · 1 of 3 done" once answered.
function briefingItem(card: InboxCard, l: Local, now: number): Item {
  const { calendar, ...meta } = card.meta ?? {};
  const picks = picksOf(card).slice(0, 3);
  const ack = card.resolution?.actionId;
  const label = ack === 'keep' ? 'Working on these' : ack === 'skip' ? 'No picks today' : card.actions?.find((a) => a.id === ack)?.label ?? ack;
  return {
    ...noExtras, key: `card-${card.id}`, kind: 'briefing', id: card.id, title: card.title, subtitle: calendar ?? '', badge: '', tone: 'muted',
    time: ago(Date.parse(card.updatedAt) / 1000, now), settled: false, swipe: settleAction(card, settledCards(l)) ?? '', count: 0,
    glyph: card.source.charAt(0).toUpperCase(), link: '', picks, meta: Object.entries(meta).map(([key, value]) => ({ key, value })),
    summary: ack ? `${label} · ${picks.filter((p) => p.done).length} of ${picks.length} done` : '',
    actions: !ack && card.state === 'open' ? (card.actions ?? []).filter((a) => !a.url).map(button) : [],
  };
}

function cardItem(card: InboxCard, settled: boolean, l: Local, now: number): Item {
  const unanswered = card.state === 'open' && !card.resolution && card.kind === 'approval';
  const answer = card.resolution ? (card.actions?.find((a) => a.id === card.resolution!.actionId)?.label ?? 'Answered') : '';
  const picks = card.picks ?? [];
  const subtitle = settled ? '' : card.kind === 'update' && picks.length
    ? `${picks.filter((p) => p.done).length} of ${picks.length} checked`
    : [card.kind === 'update' ? capitalize(card.source) : '', previewLine(card.body) ?? ''].filter(Boolean).join(' · ');
  const tone = answer ? (card.resolution!.actionId === 'approve' ? 'green' : card.resolution!.actionId === 'reject' ? 'red' : 'muted') : unanswered ? 'amber' : 'muted';
  return {
    ...noExtras, key: `card-${card.id}`, kind: 'card', id: card.id, title: card.title, subtitle,
    badge: answer || (unanswered ? 'Needs answer' : ''), tone, time: ago(Date.parse(card.updatedAt) / 1000, now), settled,
    swipe: settleAction(card, settledCards(l)) ?? '', count: 0, glyph: card.source.charAt(0).toUpperCase(), link: cardOpenPlan(card).target === 'link' ? card.url ?? '' : '',
    actions: unanswered ? (card.actions ?? []).filter((a) => !a.url).map(button) : [],
  };
}

function sessionItem(s: InboxSession, snoozed: boolean, now: number): Item {
  const badge = s.pendingApproval ? 'Needs approval' : s.running ? 'Working' : s.failed && s.attention ? 'Failed' : s.attention ? 'New result' : '';
  const tone = s.pendingApproval ? 'amber' : s.running || badge === 'New result' ? 'accent' : badge === 'Failed' ? 'red' : 'muted';
  return {
    ...noExtras, key: `session-${s.id}`, kind: 'session', id: s.id, title: s.title, subtitle: s.settled ? '' : s.preview ?? '', badge, tone,
    time: ago(s.activityAt, now), settled: s.settled, swipe: s.settled ? 'reopen' : snoozed ? 'unsnooze' : canSettleSession(s) ? 'settle' : '', count: 0, glyph: '', link: '', actions: [],
    // As in Apollo, work waiting on you can't be snoozed.
    snooze: !s.settled && !snoozed && !s.pendingApproval,
  };
}

async function inbox(showSettled: boolean, showSnoozed: boolean, query: string, now: number, store: Store, storage: Storage): Promise<Inbox> {
  try {
    const l = await state(storage);
    const [{ sessions, runs }, cloudCredential] = await Promise.all([sessionsAndRuns(store, storage), cloud(store)]);
    let cards = cardsSeen, cloudError = '';
    if (cloudCredential) {
      try { cards = [...(parseSnapshot(await request(cloudCredential.url, cloudCredential.token, '/v1/cards'))?.cards ?? cards)]; cardsSeen = cards; }
      catch (e) { cloudError = `Cards: ${message(e)}`; }
    }
    const derived = deriveSessionInbox('hermes', { sessions, runs, events: [] }, {}, l.read);
    // Auto-settle, as Apollo does: read, quiet for three hours, nothing pending.
    const due = autoSettleSessionsDue(derived, l.read, now / 1000, new Set());
    if (due.length) await settleThreads(store, Object.fromEntries(due.map((s) => [s.id, s.activityAt || Math.floor(now / 1000)]))).catch(() => {});
    const dueIds = new Set(due.map((s) => s.id));
    sessionsSeen = derived.map((s) => (dueIds.has(s.id) ? { ...s, settled: true, status: 'settled' as const } : s));
    const pendingRunIds = new Set(Object.values(runs).filter((r) => r.status === 'waiting_for_approval').map((r) => r.runId));
    l.snoozed = pruneSnoozedLedger(l.snoozed, now / 1000);
    const snoozed = (id: string) => isSessionSnoozed(l.snoozed, id, now / 1000);
    const rows = buildInboxRows({ sessions: sessionsSeen, cards, isSnoozed: snoozed, settledCards: settledCards(l), pendingRunIds, runStateLive: true, query, collapsed: { snoozed: !showSnoozed, settled: !showSettled }, now });
    const items = rows.map((row): Item => {
      if (row.kind === 'session') return sessionItem(row.session, snoozed(row.session.id), now);
      if (row.kind === 'briefing') return briefingItem(row.card, l, now);
      if (row.kind === 'card') return cardItem(row.card, row.settled, l, now);
      const blank = { ...noExtras, id: row.id, subtitle: '', badge: '', tone: 'muted', time: '', settled: false, swipe: '', glyph: '', link: '', actions: [] };
      if (row.kind === 'section') return { ...blank, key: `section-${row.id}`, kind: 'section', title: row.title, count: row.count ?? 0 };
      return { ...blank, key: 'caught-up', kind: 'caughtUp', title: "You're caught up", count: 0 };
    });
    if (query.trim() && !items.length) items.push({ ...noExtras, key: 'no-matches', kind: 'caughtUp', id: 'no-matches', title: 'No matches', subtitle: '', badge: '', tone: 'muted', time: '', settled: false, swipe: '', count: 0, glyph: '', link: '', actions: [] });
    const snoozeOptions = resolveSnoozePresets(new Date(now)).map((p) => ({ id: p.id, label: p.label, when: p.whenLabel, until: p.until }));
    return { error: cloudError, items, snoozeOptions };
  } catch (e) { return { error: e instanceof Unpaired ? '' : message(e), items: [], snoozeOptions: [] }; }
}

// ---- Cards ----

const emptyCard: CardView = {
  found: false, id: '', kind: '', source: '', title: '', body: '', plainText: false, outcome: '', url: '', threadId: '', open: false, settled: false,
  swipe: '', meta: [], metrics: [], picks: [], actions: [], progress: '', progressValue: 0, error: '',
};

async function cardView(id: string, storage: Storage): Promise<CardView> {
  const card = cardsSeen.find((c) => c.id === id);
  if (!card) return { ...emptyCard, error: 'This card is no longer in the inbox.' };
  const l = await state(storage);
  // Opening an update settles it, as Apollo does on first sight.
  if (cardOpenPlan(card).settle && settleAction(card, settledCards(l)) === 'settle') {
    l.cards = Object.fromEntries(updateSettledCards(settledCards(l), cardsSeen, card.id, true));
    await save(storage);
  }
  const settled = isCardSettled(card, settledCards(l));
  const answered = card.resolution ? card.actions?.find((a) => a.id === card.resolution!.actionId)?.label ?? card.resolution.actionId : '';
  const unanswered = card.state === 'open' && !card.resolution;
  return {
    found: true, id: card.id, kind: card.kind, source: capitalize(card.source), title: card.title, body: card.body ?? '', plainText: !!card.plainText,
    outcome: answered ? `${answered} by ${card.resolution!.by}` : card.state !== 'open' ? capitalize(card.state) : settled ? 'Settled' : '',
    url: card.url && !card.url.startsWith('apollo') ? card.url : '', threadId: hermesApprovalTarget(card).sessionId ?? '',
    open: card.state === 'open', settled, swipe: settleAction(card, settledCards(l)) ?? '',
    meta: Object.entries(card.meta ?? {}).map(([key, value]) => ({ key, value })),
    metrics: (card.metrics ?? []).map((m) => ({ label: m.label, value: `${m.value}${m.unit ? ` ${m.unit}` : ''}`, delta: m.delta ?? '', tone: m.trend ?? 'neutral' })),
    picks: picksOf(card),
    actions: unanswered || card.actions?.some((a) => a.repeat) ? (card.actions ?? []).filter((a) => unanswered || a.repeat).map(button) : [],
    progress: card.progress ? `${card.progress.label} · ${card.progress.step} of ${card.progress.of}` : '', progressValue: card.progress ? card.progress.step / Math.max(1, card.progress.of) : 0,
    error: '',
  };
}

async function respond(store: Store, cardId: string, response: CardResponse) {
  const c = await cloud(store);
  if (!c) throw new Error('Cards are not set up on this connector.');
  try {
    const body = await request(c.url, c.token, `/v1/cards/${encodeURIComponent(cardId)}/respond`, { method: 'POST', body: response, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    const card = parseCard(body);
    if (card) cardsSeen = cardsSeen.map((x) => (x.id === card.id ? card : x));
  } catch (e) {
    if ((e as { code?: string }).code !== 'card_closed') throw e; // already answered elsewhere: nothing to send
  }
}

// ---- Transcript ----

// An answer becomes one list row per markdown block (split at blank lines outside code fences),
// so the native list never lays out a multi-screen cell and a streamed delta re-lays out only
// the last block. A GFM pipe table becomes a grid, since `markup="markdown"` draws one as its
// source. Table parsing adapted from Exact's apps/agents.
type Block = { text: string; table: Row['table'] };
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cellsOf = (line: string) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
function blocks(body: string): Block[] {
  const lines = body.split('\n'), out: Block[] = [];
  let text: string[] = [], fence = '';
  const flush = () => { if (text.join('\n').trim()) out.push({ text: text.join('\n'), table: [] }); text = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, open = /^\s*(```|~~~)/.exec(line)?.[1];
    if (open && (!fence || fence === open)) fence = fence ? '' : open;
    if (!fence && !open && line.trim() === '') { flush(); continue; }
    const next = lines[i + 1];
    if (fence || open || !line.includes('|') || next === undefined || !DELIMITER.test(next)) { text.push(line); continue; }
    const head = cellsOf(line), aligns = cellsOf(next).map((d) => (d.endsWith(':') ? (d.startsWith(':') ? 'center' : 'right') : 'left'));
    const rows: string[][] = [];
    for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(cellsOf(lines[i]!));
    i--;
    flush();
    const row = (cells: string[], r: number, head: boolean) => ({ key: `r${r}`, head, cells: aligns.map((align, c) => ({ key: `c${c}`, text: cells[c] ?? '', align, first: c === 0 })) });
    out.push({ text: '', table: [row(head, 0, true), ...rows.map((cells, r) => row(cells, r + 1, false))] });
  }
  flush();
  return out;
}

const plain = { text: '', table: [], status: '', summary: '', running: false, startedAt: 0, steps: [] } satisfies Omit<Row, 'id' | 'kind'>;

// While a turn runs, what the agent writes stays inside its activity block as live commentary:
// Apollo's projector only knows text is commentary once a later tool call arrives, so showing it
// as the answer first makes it jump into the fold. The answer comes out when the run ends.
function toRows(rows: readonly TranscriptRow[]): Row[] {
  const out: Row[] = [];
  let live = false;
  for (const row of rows) {
    if (row.kind === 'user') live = false;
    if (row.kind === 'assistant') {
      out.push(...blocks(row.text).map((b, i): Row => ({ ...plain, id: `${row.id}#${i}`, kind: live ? 'live' : b.table.length ? 'table' : 'text', text: b.text, table: b.table, status: row.status ?? '' })));
      continue;
    }
    if (row.kind === 'user') {
      // The files a message carried show under it by name, not as Apollo's attachment block.
      const { text, attachments } = splitAttachmentMessage(row.text);
      out.push({ ...plain, id: row.id, kind: 'user', text, summary: attachments.map((a) => a.name).join(', '), status: row.status ?? '' });
      continue;
    }
    if (row.kind !== 'activity') { out.push({ ...plain, id: row.id, kind: row.kind, text: row.text, status: row.status ?? '' }); continue; }
    const running = row.status === 'running';
    live = running;
    out.push({
      ...plain, id: row.id, kind: 'activity', status: row.status, running, startedAt: row.startedAt ?? 0,
      summary: running ? liveActivityLabel(row, 'connected') : settledActivityLabel(row),
      steps: row.steps.map((s) => s.kind === 'tool'
        ? { key: s.id, kind: 'tool', label: [toolVerb(s.name, s.status), oneLine(s.input)].filter(Boolean).join(' '), detail: oneLine(readableOutput(s.output)), running: s.status === 'running', failed: s.status === 'failed' }
        : { key: s.id, kind: s.kind, label: s.kind === 'thought' ? 'Thought' : 'Note', detail: s.text, running: false, failed: false }),
    });
  }
  return out;
}

const emptyThread: Thread = {
  title: '', rows: [], runId: '', status: '', active: false, ended: false, error: '',
  approvalId: '', approvalTitle: '', approvalCommand: '', approvalReason: '', settled: false, canSettle: false, autoSettle: true, activityAt: 0, recent: [], model: '',
};

// iOS shows four quick actions: New thread and the three threads opened last.
// Opening a snoozed thread returns it to its section, as in Apollo.
function opened(l: Local, id: string, title: string) {
  l.snoozed = unsnoozeSession(l.snoozed, id);
  l.recent = [{ id, title }, ...l.recent.filter((r) => r.id !== id)].slice(0, 3);
  return l.recent;
}

function inboxFacts(sessionId: string) {
  const s = sessionsSeen.find((x) => x.id === sessionId);
  return { settled: s?.settled ?? false, canSettle: s ? canSettleSession(s) : false, autoSettle: !(s?.autoSettleDisabled ?? false), activityAt: s?.activityAt ?? 0 };
}

async function history(store: Store, sessionId: string) {
  const [session, list] = await Promise.all([api(store, `/api/sessions/${encodeURIComponent(sessionId)}`), api(store, `/api/sessions/${encodeURIComponent(sessionId)}/messages`)]);
  return { title: str((session.session as Json | undefined)?.title) || 'New thread', messages: ((list.data as Json[] | undefined) ?? []).map(parseMessage) };
}

// History alone, or history plus the session's active run as a stream: each chunk of the run's
// events is parsed and mapped through Apollo's projector, and commits as the next answer.
async function transcript(sessionId: string, now: number, store: Store, storage: Storage): Promise<Thread> {
  if (!sessionId) return emptyThread;
  try {
    const project = createTranscriptProjector();
    const l = await state(storage);
    const { title, messages } = await history(store, sessionId);
    const recent = opened(l, sessionId, title);
    const runId = l.runs[sessionId];
    let run = runId ? parseRun(await api(store, `/v1/runs/${encodeURIComponent(runId)}`).catch(() => ({ run_id: runId, status: 'unknown' }))) : undefined;
    if (!runId || !run || !isRunActive(run.status)) {
      // A thread read with nothing running is read, as Apollo marks it.
      if (runId) delete l.runs[sessionId];
      l.read[sessionId] = Math.floor(now / 1000);
      await save(storage);
      return { ...emptyThread, ...inboxFacts(sessionId), model: l.models[sessionId] ?? "", recent, title, rows: toRows(project({ history: messages, events: [], running: false })) };
    }
    await save(storage);
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
        ...emptyThread, ...inboxFacts(sessionId), model: l.models[sessionId] ?? "", canSettle: false, recent, title, rows: toRows(rows), runId, status: current.status, active: running, ended: !running, error,
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
    // connector is asked for the same frames as bytes, which Exact never drops. A connector
    // without that option answers SSE, read as before (it can drop deltas; the run's final
    // output still replaces them).
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
            const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (data) try { take(data); } catch { /* a malformed frame is skipped, as Apollo does */ }
          }
        } else if (typeof e.data === 'string' && e.data) {
          try { take(e.data); } catch { /* skipped */ }
        }
        return snapshot();
      },
    } as RequestInit) as unknown as Promise<Thread>;
  } catch (e) {
    return { ...emptyThread, error: message(e), ended: true };
  }
}

// ---- Models, skills, toolsets and attachments ----

type Options = Result<'agentOptions'>;
type Draft = Parameters<Sources['startRun']>[0][2][number];
const modelKey = (provider: string, id: string) => `${provider}|${id}`;
let skillsSeen: { name: string; description?: string }[] = [];

// What the composer and Settings offer: Hermes's models (Apollo's /api/model/options, else
// /v1/models), its skills and its toolsets. Each part fails alone.
async function agentOptions(store: Store): Promise<Options> {
  const [caps, options, skills, toolsets] = await Promise.all([
    api(store, '/v1/capabilities').catch(() => ({} as Json)),
    api(store, '/api/model/options').catch(() => api(store, '/v1/models').catch(() => ({} as Json))),
    api(store, '/v1/skills').catch(() => ({} as Json)),
    api(store, '/v1/toolsets').catch(() => ({} as Json)),
  ]);
  const models: Options['models'] = [];
  if (Array.isArray(options.providers)) {
    for (const p of options.providers as Json[]) {
      if (typeof p.slug !== 'string' || !Array.isArray(p.models) || p.authenticated === false) continue;
      const unavailable = Array.isArray(p.unavailable_models) ? p.unavailable_models : [];
      for (const m of p.models) {
        if (typeof m !== 'string' || unavailable.includes(m)) continue;
        const aliases = Array.isArray(p.aliases) ? p.aliases : [];
        const isDefault = m === options.model && (p.slug === options.provider || aliases.includes(options.provider));
        models.push({ key: modelKey(p.slug, m), id: m, provider: p.slug, label: m === 'hermes-agent' ? 'Default' : m, isDefault });
      }
    }
  } else {
    for (const m of ((options.data ?? options.models ?? []) as Json[])) {
      const id = str(m.id);
      if (id) models.push({ key: modelKey('hermes', id), id, provider: 'hermes', label: id === 'hermes-agent' ? 'Default' : id, isDefault: id === caps.model });
    }
  }
  skillsSeen = ((skills.data ?? []) as Json[]).flatMap((k) => (typeof k.name === 'string' ? [{ name: k.name, description: str(k.description) }] : []));
  return {
    models, defaultModel: str(caps.model) ?? '', platform: str(caps.platform) ?? '', error: '',
    skills: skillsSeen.map((k) => ({ name: k.name, description: k.description ?? '' })),
    toolsets: ((toolsets.data ?? []) as Json[]).flatMap((t) => (typeof t.name === 'string'
      ? [{ name: t.name, label: str(t.label) ?? t.name, enabled: t.enabled === true, tools: Array.isArray(t.tools) ? t.tools.length : 0 }] : [])),
  };
}

// The connector keeps a picked file under its state folder; the message names its path, as
// Apollo's does. A large photo is shrunk first, as Apollo's 2000 px, 5 MB fit does.
async function upload(store: Store, storage: Storage, file: Draft): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Choose files no larger than 25 MB each.');
  let path = file.path, type = file.type || 'application/octet-stream', name = file.name;
  if (type.startsWith('image/') && (file.size > 5_000_000 || /hei[cf]/.test(type))) {
    const out = await storage.fs.compressImage(path, `app:/tmp/upload/${crypto.randomUUID()}.jpg`, { maxDimension: 2000, maxBytes: 5_000_000 });
    path = out.path; type = out.type; name = name.replace(/\.[^.]+$/, '') + '.jpg';
  }
  const bytes = await storage.fs.readFile(path);
  const { endpoint, token } = await credential(store);
  const res = await fetch(`${endpoint}/v1/apollo/attachments?name=${encodeURIComponent(name)}`, {
    method: 'POST', exactTimeout: 120000, headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body: bytes,
  } as RequestInit);
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(str((body.error as Json | undefined)?.message) ?? `Upload failed (HTTP ${res.status})`);
  return body.attachment as Attachment;
}

async function start(store: Store, storage: Storage, sessionId: string, text: string, files: readonly Draft[] = []) {
  const l = await state(storage);
  const attachments = [];
  for (const f of files) attachments.push(await upload(store, storage, f));
  const input = attachmentMessage(text, attachments);
  // A $name a person typed picks that skill, as in Apollo: Hermes is told to load it first.
  const skills = selectedSkillNames(text, skillsSeen);
  const instructions = skills.length
    ? `The user explicitly selected these installed skills: ${JSON.stringify(skills)}. Before responding, call skill_view for each exact name and follow its instructions. The $name references in the message identify these selections. If a skill cannot be loaded, tell the user.`
    : undefined;
  const [provider, model] = (l.models[sessionId] ?? '').split('|');
  const run = await api(store, '/v1/runs', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { input, session_id: sessionId, ...(model ? { model, ...(provider && provider !== 'hermes' ? { provider } : {}) } : {}), ...(instructions ? { instructions } : {}) },
  });
  l.runs[sessionId] = String(run.run_id);
  await save(storage);
}

const ok = { error: '' };
const failed = (e: unknown) => ({ error: message(e) });

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
      const grant = body.cloud as Json | undefined;
      const saved: Credential = { endpoint, token: String(body.access_token), label: str(descriptor.label) ?? 'Hermes', ...(str(grant?.url) && str(grant?.token) ? { cloud: { url: String(grant!.url).replace(/\/$/, ''), token: String(grant!.token) } } : {}) };
      await store.set(SECRET, JSON.stringify(saved));
      cloudAsked = false;
      return ok;
    } catch (e) { return failed(e); }
  },
  unpair: async (_args, store, storage) => {
    await store.forget(SECRET);
    local = fresh();
    await save(storage);
    sessionsSeen = []; cardsSeen = [];
    return ok;
  },
  inbox: ([, , showSettled, showSnoozed, query, now], store, storage) => { setClock(now); return inbox(showSettled, showSnoozed, query, now, store, storage); },
  snooze: async ([sessionId, until], _store, storage) => {
    const l = await state(storage);
    l.snoozed = until > 0 ? snoozeSession(l.snoozed, sessionId, until) : unsnoozeSession(l.snoozed, sessionId);
    await save(storage);
    return ok;
  },
  card: ([id], _store, storage) => cardView(id, storage),
  transcript: ([sessionId, , now], store, storage) => { setClock(now); return transcript(sessionId, now, store, storage); },
  agentOptions: async (_args, store) => {
    try { return await agentOptions(store); }
    catch (e) { return { models: [], skills: [], toolsets: [], defaultModel: '', platform: '', error: e instanceof Unpaired ? '' : message(e) }; }
  },
  // A new thread's model is saved before its first run; an open thread's is locked on Hermes.
  setModel: async ([sessionId, key], store, storage) => {
    try {
      const l = await state(storage);
      const [provider, model] = key.split('|');
      if (key) {
        const res = await api(store, `/api/sessions/${encodeURIComponent(sessionId)}/model`, { method: 'POST', body: { model, ...(provider && provider !== 'hermes' ? { provider } : {}) } });
        if ((res.runtime as Json | undefined)?.model_lock !== 'accepted') throw new Error('Hermes kept the current model for this thread.');
        l.models[sessionId] = key;
      } else delete l.models[sessionId];
      await save(storage);
      return ok;
    } catch (e) { return failed(e); }
  },
  deleteThread: async ([sessionId], store, storage) => {
    try {
      await api(store, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      const l = await state(storage);
      for (const ledger of [l.runs, l.read, l.snoozed, l.models]) delete ledger[sessionId];
      l.recent = l.recent.filter((r) => r.id !== sessionId);
      await save(storage);
      return ok;
    } catch (e) { return failed(e); }
  },
  createThread: async ([input, model, files], store, storage) => {
    try {
      const id = crypto.randomUUID();
      await api(store, '/api/sessions', { method: 'POST', body: { id, title: (input.split('\n')[0] || files[0]?.name || 'New thread').slice(0, 72) } });
      if (model) { const l = await state(storage); l.models[id] = model; }
      await start(store, storage, id, input, files);
      return { id, error: '' };
    } catch (e) { return { id: '', error: message(e) }; }
  },
  startRun: async ([sessionId, input, files], store, storage) => { try { await start(store, storage, sessionId, input, files); return ok; } catch (e) { return failed(e); } },
  stopRun: async ([runId], store) => { try { await api(store, `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }); return ok; } catch (e) { return failed(e); } },
  answerApproval: async ([runId, requestId, choice], store) => {
    try { await api(store, `/v1/runs/${encodeURIComponent(runId)}/approval`, { method: 'POST', body: { choice, ...(requestId ? { request_id: requestId } : {}) } }); return ok; }
    catch (e) { return failed(e); }
  },
  // Settle or reopen a thread on the connector, shared with every paired phone.
  settleThread: async ([sessionId, settle, now], store) => {
    try {
      const at = sessionsSeen.find((s) => s.id === sessionId)?.activityAt || Math.floor(now / 1000);
      await settleThreads(store, { [sessionId]: settle ? at : null });
      return ok;
    } catch (e) { return failed(e); }
  },
  setAutoSettle: async ([sessionId, on], store) => {
    try { await api(store, '/v1/inbox', { method: 'PATCH', body: { importOnly: false, settled: {}, config: { [sessionId]: { auto_settle: on } } } }); return ok; }
    catch (e) { return failed(e); }
  },
  // Cards settle on this phone only: the Worker lets only producers close them.
  settleCard: async ([cardId, settle], _store, storage) => {
    const l = await state(storage);
    l.cards = Object.fromEntries(updateSettledCards(settledCards(l), cardsSeen, cardId, settle));
    await save(storage);
    return ok;
  },
  respondCard: async ([cardId, actionId, text], store) => {
    try { await respond(store, cardId, text ? { actionId, text } : { actionId }); return ok; } catch (e) { return failed(e); }
  },
  togglePick: async ([cardId, n, done], store) => {
    try { await respond(store, cardId, { pick: n, done }); return ok; } catch (e) { return failed(e); }
  },
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
