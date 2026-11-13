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
import { createTranscriptProjector, cronDelivery, type TranscriptRow } from './apollo/src/features/relay/transcript.ts';
import { setClock } from './apollo/clock.ts';
import { normalizeEndpoint } from './apollo/src/lib/endpoint.ts';
import { currentApproval, isRunActive, statusAfterEvent } from './apollo/src/lib/run-state.ts';
import type { HermesMessage, HermesRunEvent, HermesRunState, HermesRunStatus, HermesSession } from './apollo/src/lib/types.ts';

const SECRET = 'apollo.credential';
const STATE = 'app:/data/state.json';
export const appId = 'com.matthewchisolm.apollo.exactspike';
// `https:` admits the connector and cloud the pairing names; loopback http is tools/fixture.mjs.
export const grants = ['net.fetch https:', 'net.fetch http://127.0.0.1:19111', 'net.fetch http://127.0.0.1:19113', `secret.keep ${SECRET}`, `fs.read ${STATE}`, `fs.write ${STATE}`, 'fs.read app:/cache', 'fs.write app:/cache', 'fs.read app:/tmp', 'fs.write app:/tmp', 'device.microphone purpose.microphone', 'device.speech-recognition purpose.recognition'].join('\n');

type Thread = Result<'transcript'>;
type Row = Thread['rows'][number];
type Inbox = Result<'inbox'>;
type Item = Inbox['items'][number];
type CardView = Result<'card'>;
type Routine = Result<'routines'>['items'][number];
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
// cached: the threads kept in app:/cache, newest first.
type Local = { runs: Record<string, string>; read: Record<string, number>; cards: Record<string, number>; recent: { id: string; title: string }[]; snoozed: Record<string, number>; models: Record<string, string>; cached: string[] };
const fresh = (): Local => ({ runs: {}, read: {}, cards: {}, recent: [], snoozed: {}, models: {}, cached: [] });
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

// ---- What the phone keeps to draw before the connector answers ----
// The inbox's inputs and the threads opened last, in app:/cache. Each is drawn only until the live
// answer lands, says it is not live, and drives no action. Unpairing clears it.

const INBOX_CACHE = 'app:/cache/inbox.json';
const threadCache = (id: string) => `app:/cache/thread-${encodeURIComponent(id)}.json`;
const KEEP_THREADS = 30;
// A thread opens at its end, so its last rows are all a kept copy needs; the live answer brings the rest.
const KEEP_ROWS = 50;
// A thread's pending approval, so its inbox row can answer it.
type Ask = { runId: string; requestId: string; command: string; reason: string; choices: string[] };
type InboxInputs = { sessions: InboxSession[]; cards: Card[]; pendingRunIds: string[]; asks?: Record<string, Ask>; routines?: Routine[] };

async function readCache<T>(storage: Storage, path: string): Promise<T | undefined> {
  const bytes = await storage.fs.readFile(path).catch(() => null);
  try { return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : undefined; } catch { return undefined; }
}
const writeCache = (storage: Storage, path: string, value: unknown) =>
  storage.fs.atomicWriteFile(path, new TextEncoder().encode(JSON.stringify(value))).catch(() => {});

async function keepThread(storage: Storage, l: Local, thread: Thread) {
  const kept = [thread.id, ...l.cached.filter((id) => id !== thread.id)];
  l.cached = kept.slice(0, KEEP_THREADS);
  await Promise.all([writeCache(storage, threadCache(thread.id), thread), ...kept.slice(KEEP_THREADS).map((id) => storage.fs.rm(threadCache(id)).catch(() => {}))]);
}
async function forgetThread(storage: Storage, l: Local, id: string) {
  l.cached = l.cached.filter((x) => x !== id);
  await storage.fs.rm(threadCache(id)).catch(() => {});
}

// ---- Hermes parsing, as Apollo's hermes-client does it ----

const parseMessage = (v: Json): HermesMessage => ({
  id: str(v.id), sequence: num(v.id), sessionId: str(v.session_id), role: str(v.role) ?? 'system', content: str(v.content),
  toolCallId: str(v.tool_call_id), toolName: str(v.tool_name), toolCalls: Array.isArray(v.tool_calls) ? (v.tool_calls as Json[]) : undefined,
  timestamp: num(v.timestamp), finishReason: str(v.finish_reason), reasoning: str(v.reasoning), reasoningContent: str(v.reasoning_content), displayKind: str(v.display_kind),
});
const parseEvent = (v: Json): HermesRunEvent => ({ ...v, event: String(v.event), runId: str(v.run_id), timestamp: num(v.timestamp), text: str(v.text), tool: str(v.tool), preview: str(v.preview) });
// `pending_steer`: steer text Hermes never delivered, on an ended run's status.
const parseRun = (v: Json): HermesRunStatus & { pendingSteer?: string } => ({
  runId: String(v.run_id), status: (str(v.status) ?? 'unknown') as HermesRunState, sessionId: str(v.session_id), output: str(v.output),
  error: str(v.error), createdAt: num(v.created_at), updatedAt: num(v.updated_at), approval: v.approval as HermesRunStatus['approval'], pendingSteer: str(v.pending_steer),
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
// False while cardsSeen holds the cache's cards, before the cloud answered this launch.
let cardsLive = false;
// Cards reopened this launch: opening one again leaves it open, as Apollo's detail screen does.
const reopened = new Set<string>();

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
      // What an ended run never delivered outlives the run's place in the ledger.
      const lost = str(run.pendingSteer);
      if (lost && !isRunActive(run.status)) undelivered.set(sessionId, lost);
      if (!isRunActive(run.status) && l.runs[sessionId] === runId) delete l.runs[sessionId];
    } catch (e) {
      // Only a run Hermes no longer knows leaves the ledger; one that didn't answer is asked again,
      // and counts as running meanwhile so its thread can't be settled.
      if ((e as { status?: number }).status === 404) { if (l.runs[sessionId] === runId) delete l.runs[sessionId]; }
      else runs[runId] = { runId, status: 'running', sessionId };
    }
  }));
  await save(storage);
  return { sessions, runs };
}

async function settleThreads(store: Store, settled: Record<string, number | null>) {
  await api(store, '/v1/inbox', { method: 'PATCH', body: { importOnly: false, settled } });
}

const picksOf = (card: Card) => (card.picks ?? []).map((p) => ({ n: p.n, text: p.text, sub: p.sub ?? '', url: p.url ?? '', done: p.done }));
const button = (a: CardAction) => ({ id: a.id, label: a.label, style: a.style ?? 'default', input: a.input === 'text', url: a.url ?? '' });
const noExtras = { picks: [], meta: [], summary: '', snooze: false, need: '', command: '', runId: '', requestId: '', choices: [] } satisfies Pick<Item, 'picks' | 'meta' | 'summary' | 'snooze' | 'need' | 'command' | 'runId' | 'requestId' | 'choices'>;

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
    ...noExtras, key: `card-${card.id}`, kind: 'card', id: card.id, title: card.title, subtitle: unanswered && !settled ? `From ${card.source}` : subtitle, need: unanswered ? 'answer' : '',
    badge: answer || (unanswered ? 'Needs answer' : ''), tone, time: ago(Date.parse(card.updatedAt) / 1000, now), settled,
    swipe: settleAction(card, settledCards(l)) ?? '', count: 0, glyph: card.source.charAt(0).toUpperCase(), link: cardOpenPlan(card).target === 'link' ? card.url ?? '' : '',
    actions: unanswered ? (card.actions ?? []).filter((a) => !a.url).map(button) : [],
  };
}

function sessionItem(s: InboxSession, snoozed: boolean, now: number, ask?: Ask): Item {
  const badge = s.pendingApproval ? 'Needs approval' : s.running ? 'Working' : s.failed && s.attention ? 'Failed' : s.attention ? 'New result' : '';
  const tone = s.pendingApproval ? 'amber' : s.running || badge === 'New result' ? 'accent' : badge === 'Failed' ? 'red' : 'muted';
  return {
    ...noExtras, key: `session-${s.id}`, kind: 'session', id: s.id, title: s.title, subtitle: s.settled ? '' : s.preview ?? '', badge, tone,
    time: ago(s.activityAt, now), settled: s.settled, swipe: s.settled ? 'reopen' : snoozed ? 'unsnooze' : canSettleSession(s) ? 'settle' : '', count: 0, glyph: '', link: '', actions: [],
    // As in Apollo, work waiting on you can't be snoozed.
    snooze: !s.settled && !snoozed && !s.pendingApproval,
    ...(s.pendingApproval && ask?.requestId ? { need: 'approve', subtitle: ask.reason, command: ask.command, runId: ask.runId, requestId: ask.requestId, choices: ask.choices } : {}),
  };
}

// The Feedback and Routines rows, under what waits on you: each says what needs a look, if anything.
function placeRows(feedback: Item[], routines: Routine[]): Item[] {
  const row = { ...noExtras, subtitle: '', time: '', settled: false, swipe: '', count: 0, glyph: '', link: '', actions: [] };
  const waiting = feedback.filter((f) => f.need).length;
  const failing = routines.filter((r) => r.status === 'failed');
  const first = failing[0];
  return [
    ...(feedback.length ? [{ ...row, key: 'feedback', kind: 'feedback', id: 'feedback', title: 'Feedback', badge: waiting ? `${waiting} waiting on you` : '', tone: 'amber' }] : []),
    ...(routines.length ? [{ ...row, key: 'routines', kind: 'routines', id: 'routines', title: 'Routines', tone: 'red',
      badge: failing.length > 1 ? `${failing.length} failing` : first ? `${first.name} failed${first.streak > 1 ? ` ${first.streak}×` : ''}` : '' }] : []),
  ];
}

// The inbox's rows from its inputs, live or kept.
function inboxOf({ sessions, cards: all, pendingRunIds, asks = {}, routines = [] }: InboxInputs, l: Local, showSettled: boolean, showSnoozed: boolean, query: string, now: number, live: boolean): Inbox {
  const snoozed = (id: string) => isSessionSnoozed(l.snoozed, id, now / 1000);
  // Player reports sit behind the Feedback row, not among the inbox's own cards.
  const cards = all.filter((c) => c.source !== 'feedback');
  const rows = buildInboxRows({ sessions, cards, isSnoozed: snoozed, settledCards: settledCards(l), pendingRunIds: new Set(pendingRunIds), runStateLive: live, fresh: live, query, collapsed: { snoozed: !showSnoozed, settled: !showSettled }, now });
  const listed = rows.map((row): Item => {
    if (row.kind === 'session') return sessionItem(row.session, snoozed(row.session.id), now, asks[row.session.id]);
    if (row.kind === 'briefing') return briefingItem(row.card, l, now);
    if (row.kind === 'card') return cardItem(row.card, row.settled, l, now);
    const blank = { ...noExtras, id: row.id, subtitle: '', badge: '', tone: 'muted', time: '', settled: false, swipe: '', glyph: '', link: '', actions: [] };
    if (row.kind === 'section') return { ...blank, key: `section-${row.id}`, kind: 'section', title: row.title, count: row.count ?? 0 };
    return { ...blank, key: 'caught-up', kind: 'caughtUp', title: "You're caught up", count: 0 };
  });
  const reports = all.filter((c) => c.source === 'feedback').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((c) => ({ ...cardItem(c, false, l, now), subtitle: previewLine(c.body) ?? '' }));
  const feedback = [...reports.filter((r) => r.need), ...reports.filter((r) => !r.need)];
  // What waits on you comes first, then Feedback and Routines, then the rest in Apollo's order.
  const items = [...listed.filter((it) => it.need), ...(query.trim() ? [] : placeRows(feedback, routines)), ...listed.filter((it) => !it.need)];
  if (query.trim() && !items.length) items.push({ ...noExtras, key: 'no-matches', kind: 'caughtUp', id: 'no-matches', title: 'No matches', subtitle: '', badge: '', tone: 'muted', time: '', settled: false, swipe: '', count: 0, glyph: '', link: '', actions: [] });
  const snoozeOptions = resolveSnoozePresets(new Date(now)).map((p) => ({ id: p.id, label: p.label, when: p.whenLabel, until: p.until }));
  // A kept row can't be swiped: settling or snoozing goes by what the connector says now.
  return { error: '', live, items: live ? items : items.map((it) => ({ ...it, swipe: '', snooze: false })), snoozeOptions, feedback };
}

async function inbox(showSettled: boolean, showSnoozed: boolean, query: string, now: number, store: Store, storage: Storage): Promise<Inbox> {
  try {
    const l = await state(storage);
    const [{ sessions, runs }, cloudCredential, jobs] = await Promise.all([sessionsAndRuns(store, storage), cloud(store), routines(store, now)]);
    let cards = cardsSeen, cloudError = '';
    if (cloudCredential) {
      try { cards = [...(parseSnapshot(await request(cloudCredential.url, cloudCredential.token, '/v1/cards'))?.cards ?? cards)]; cardsSeen = cards; cardsLive = true; }
      catch (e) { cloudError = `Cards: ${message(e)}`; }
    }
    const derived = deriveSessionInbox('hermes', { sessions, runs, events: [] }, {}, l.read);
    // Auto-settle, as Apollo does: read, quiet for three hours, nothing pending.
    const due = autoSettleSessionsDue(derived, l.read, now / 1000, new Set());
    if (due.length) await settleThreads(store, Object.fromEntries(due.map((s) => [s.id, s.activityAt || Math.floor(now / 1000)]))).catch(() => {});
    const dueIds = new Set(due.map((s) => s.id));
    sessionsSeen = derived.map((s) => (dueIds.has(s.id) ? { ...s, settled: true, status: 'settled' as const } : s));
    const pendingRunIds = Object.values(runs).filter((r) => r.status === 'waiting_for_approval').map((r) => r.runId);
    l.snoozed = pruneSnoozedLedger(l.snoozed, now / 1000);
    const asks: Record<string, Ask> = {};
    for (const r of Object.values(runs)) {
      const command = str(r.approval?.command) ?? str(r.approval?.preview);
      if (r.status !== 'waiting_for_approval' || !r.sessionId || !command) continue;
      asks[r.sessionId] = { runId: r.runId, requestId: str(r.approval?.request_id) ?? r.approval?.requestId ?? '', command, reason: r.approval?.description ?? '', choices: approvalChoices(r.approval?.choices) };
    }
    const inputs: InboxInputs = { sessions: sessionsSeen, cards, pendingRunIds, asks, routines: jobs.items };
    await writeCache(storage, INBOX_CACHE, inputs);
    return { ...inboxOf(inputs, l, showSettled, showSnoozed, query, now, true), error: cloudError };
  } catch (e) { return { error: e instanceof Unpaired ? '' : message(e), live: false, items: [], snoozeOptions: [], feedback: [] }; }
}

// The last inbox this phone saw, drawn until the live one lands. Its cards stand in for the card
// screen until then too, marked not live.
async function savedInbox(paired: boolean, showSettled: boolean, showSnoozed: boolean, query: string, now: number, storage: Storage): Promise<Inbox> {
  const none: Inbox = { error: '', live: false, items: [], snoozeOptions: [], feedback: [] };
  if (!paired) return none;
  const inputs = await readCache<InboxInputs>(storage, INBOX_CACHE);
  if (!inputs) return none;
  if (!cardsSeen.length) cardsSeen = inputs.cards;
  return inboxOf(inputs, await state(storage), showSettled, showSnoozed, query, now, false);
}

// ---- Cards ----

const emptyCard: CardView = {
  found: false, id: '', kind: '', source: '', title: '', body: '', plainText: false, outcome: '', url: '', threadId: '', open: false, settled: false,
  swipe: '', meta: [], metrics: [], picks: [], actions: [], progress: '', progressValue: 0, error: '', live: false,
};

async function cardView(id: string, storage: Storage): Promise<CardView> {
  const card = cardsSeen.find((c) => c.id === id);
  if (!card) return { ...emptyCard, error: 'This card is no longer in the inbox.' };
  const l = await state(storage);
  // Opening an update settles it, as Apollo does on first sight.
  if (cardsLive && !reopened.has(card.id) && cardOpenPlan(card).settle && settleAction(card, settledCards(l)) === 'settle') {
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
    error: '', live: cardsLive,
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
    // A cron delivery folds to its job's name, as in Apollo; tapping shows what the job sent.
    const cron = row.kind === 'system' ? cronDelivery(row.text) : undefined;
    if (cron) { out.push({ ...plain, id: row.id, kind: 'cron', summary: cron.job, text: cron.text }); continue; }
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
  id: '', live: false, title: '', rows: [], runId: '', status: '', active: false, ended: false, error: '',
  approvalId: '', approvalTitle: '', approvalCommand: '', approvalReason: '', approvalChoices: [], settled: false, canSettle: false, autoSettle: true, activityAt: 0, recent: [], model: '',
};

// The tiers Hermes offers for this request, in its order; a request without them gets its two always-safe ones.
const CHOICES = ['once', 'session', 'always', 'deny'];
const approvalChoices = (choices: unknown) => {
  const offered = Array.isArray(choices) ? CHOICES.filter((c) => choices.includes(c)) : [];
  return offered.length ? offered : ['once', 'deny'];
};

// Steers this phone sent into a running turn, drawn under it until Hermes's history has them, and
// what Hermes said it never delivered (`pending_steer` on a terminal event), until the next send.
// A steer is in history once its text shows more often than `before`: what history held when it
// was sent, plus the same words still waiting then. So an earlier message with the same words
// doesn't hide it, and a repeated steer waits for its own copy.
const steers = new Map<string, { text: string; before: number }[]>();
// The run each thread last steered, kept past the run ledger so a reopened thread can still check it.
const steeredRun = new Map<string, string>();
const undelivered = new Map<string, string>();
const rowsSeen = new Map<string, Row[]>();
const said = (rows: Row[], text: string) => rows.filter((r) => r.kind === 'user' && r.text.trim() === text).length;
// The steers sent into a run that history doesn't show yet, with their place in the order sent.
const unseen = (rows: Row[], runId: string) => (steers.get(runId) ?? []).flatMap(({ text, before }, i) => (said(rows, text) > before ? [] : [{ text, i }]));
function withSteers(rows: Row[], sessionId: string, runId: string): Row[] {
  rowsSeen.set(sessionId, rows);
  const echoes = unseen(rows, runId).map(({ text, i }): Row => ({ ...plain, id: `steer-${runId}-${i}`, kind: 'user', text, status: 'steered' }));
  const lost = undelivered.get(sessionId);
  return [...rows, ...echoes, ...(lost ? [{ ...plain, id: `undelivered-${sessionId}`, kind: 'error', text: `Hermes finished before it read: “${lost}”. Send it again as a new message.` }] : [])];
}

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
    const runId = l.runs[sessionId] ?? steeredRun.get(sessionId);
    let unreachable = false;
    const status = runId ? await api(store, `/v1/runs/${encodeURIComponent(runId)}`).catch((e) => { unreachable = (e as { status?: number }).status !== 404; return { run_id: runId, status: 'unknown' } as Json; }) : undefined;
    let run = status ? parseRun(status) : undefined;
    // A run that ended while the thread was closed still says what it never delivered.
    const lostBefore = str(status?.pending_steer);
    if (lostBefore && run && !isRunActive(run.status)) undelivered.set(sessionId, lostBefore);
    if (!runId || !run || !isRunActive(run.status)) {
      // A run that didn't answer may still be going: it stays in the ledger with its steers, and
      // the thread says so with Retry rather than looking idle.
      if (runId && unreachable) {
        // Shown as still running, so Stop stays and nothing new is sent over it.
        const thread: Thread = { ...emptyThread, ...inboxFacts(sessionId), id: sessionId, live: true, model: l.models[sessionId] ?? "", recent, title, canSettle: false,
          rows: withSteers(toRows(project({ history: messages, events: [], running: false })), sessionId, runId), runId, status: 'unknown', active: true, error: 'Could not reach the running turn. Retry to check on it.' };
        await save(storage);
        return thread;
      }
      // A thread read with nothing running is read, as Apollo marks it.
      if (runId && l.runs[sessionId] === runId) delete l.runs[sessionId];
      l.read[sessionId] = Math.floor(now / 1000);
      let rows = toRows(project({ history: messages, events: [], running: false }));
      // A steer the ended run neither saved nor named as undelivered never reached it either. History
      // read before the run's status can miss a steer saved as it ended, so it is read once more.
      if (runId) {
        if (unseen(rows, runId).length) rows = toRows(createTranscriptProjector()({ history: (await history(store, sessionId)).messages, events: [], running: false }));
        const missed = unseen(rows, runId).map((m) => m.text);
        // Hermes joins every steer it never delivered with newlines, so a steer it named is a whole
        // line run of that text.
        const named = (text: string) => lostBefore !== undefined && `\n${lostBefore}\n`.includes(`\n${text}\n`);
        const lost = [...(lostBefore ? [lostBefore] : []), ...missed.filter((text) => !named(text))];
        if (lost.length) undelivered.set(sessionId, lost.join('\n'));
        steers.delete(runId);
        steeredRun.delete(sessionId);
      }
      const thread: Thread = { ...emptyThread, ...inboxFacts(sessionId), id: sessionId, live: true, model: l.models[sessionId] ?? "", recent, title, rows: withSteers(rows, sessionId, '') };
      // The kept copy leaves out the undelivered note, which lasts only until the next send.
      await keepThread(storage, l, { ...thread, recent: [], rows: thread.rows.filter((r) => !r.id.startsWith('undelivered-')).slice(-KEEP_ROWS) });
      await save(storage);
      return thread;
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
      const requestId = str(approval?.request_id) ?? approval?.requestId ?? '';
      // The request where it happened in the transcript; the pinned copy above the composer answers it.
      const asked: Row[] = approval && command ? [{ id: `approval-${requestId}`, kind: 'approval', text: command, table: [], status: '', summary: approval.description ?? '', running: false, startedAt: 0, steps: [] }] : [];
      return {
        ...emptyThread, ...inboxFacts(sessionId), id: sessionId, live: true, model: l.models[sessionId] ?? "", canSettle: false, recent, title, rows: [...withSteers(toRows(rows), sessionId, runId), ...asked], runId, status: current.status, active: running, ended: !running, error,
        ...(approval && command ? { approvalId: requestId, approvalTitle: approval.tool ? `Allow ${approval.tool}?` : 'Allow this command?', approvalCommand: command, approvalReason: approval.description ?? '', approvalChoices: approvalChoices(approval.choices) } : {}),
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
      const lost = str(event.pending_steer);
      if (lost && !isRunActive(run.status)) undelivered.set(sessionId, lost);
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

// The thread as last read on this phone, drawn until the live one lands. A thread never kept
// answers blank, for this id, so no other thread's rows show under its title.
async function savedTranscript(sessionId: string, storage: Storage): Promise<Thread> {
  const kept = sessionId ? await readCache<Thread>(storage, threadCache(sessionId)) : undefined;
  return { ...emptyThread, ...kept, id: sessionId, live: false, recent: [] };
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
  // A new message starts over: what the last run left undelivered was said, and its steers are done.
  undelivered.delete(sessionId);
  const last = steeredRun.get(sessionId);
  if (last) steers.delete(last);
  steeredRun.delete(sessionId);
  await save(storage);
}

// ---- Routines: Hermes's cron jobs, read-only ----

type Routines = Result<'routines'>;
const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const clockTime = (h: number, m: number) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
const every = (minutes: number) => minutes % 1440 === 0 ? (minutes === 1440 ? 'Every day' : `Every ${minutes / 1440} days`)
  : minutes % 60 === 0 ? (minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`) : minutes === 1 ? 'Every minute' : `Every ${minutes} minutes`;

// A job's schedule as a person says it; anything else stays as Hermes wrote it.
function scheduleLabel(display: string): string {
  const interval = /^every (\d+)m$/u.exec(display);
  if (interval) return every(Number(interval[1]));
  const cron = /^(\S+) (\S+) \* \* (\S+)$/u.exec(display);
  if (!cron) return capitalize(display);
  const [, minute, hour, days] = cron as unknown as [string, string, string, string];
  // */n only keeps an even pace when n divides the hour: */45 runs at :00 and :45.
  if (hour === '*' && days === '*') return minute === '*' ? 'Every minute' : minute === '0' ? 'Every hour' : /^\*\/\d+$/u.test(minute) && 60 % Number(minute.slice(2)) === 0 ? every(Number(minute.slice(2))) : display;
  if (!/^\d+$/u.test(minute) || !/^\d+$/u.test(hour)) return display;
  const at = clockTime(Number(hour), Number(minute));
  if (days === '*') return `Daily at ${at}`;
  if (days === '1-5') return `Weekdays at ${at}`;
  if (/^[0-6]$/u.test(days)) return `${WEEKDAYS[Number(days)]} at ${at}`;
  return display;
}

const until = (seconds: number, now: number) => {
  const s = seconds - now / 1000;
  if (s < 0) return 'due';
  if (s < 60) return 'soon';
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
};
const when = (iso: unknown) => { const t = typeof iso === 'string' ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t / 1000 : undefined; };

async function routines(store: Store, now: number): Promise<Routines> {
  try {
    const body = await api(store, '/api/jobs');
    if (!Array.isArray(body.jobs)) throw new Error('Hermes sent routines in a form this app does not read.');
    const jobs = body.jobs as Json[];
    const items = jobs.map((j) => {
      const paused = j.enabled === false || j.state === 'paused';
      const failed = !paused && j.last_status != null && j.last_status !== 'ok';
      const last = when(j.last_run_at), next = when(j.next_run_at);
      const streak = num(j.failure_streak) ?? 0;
      return {
        id: String(j.id), name: str(j.name) ?? 'Routine', schedule: scheduleLabel(str(j.schedule_display) ?? ''),
        status: paused ? 'paused' : failed ? 'failed' : last ? 'ok' : 'new',
        last: last ? ago(last, now) : '', next: !paused && next ? until(next, now) : '',
        error: failed ? str(j.last_error) ?? '' : '', streak: failed ? streak : 0,
      };
    });
    // What needs you first, then by name.
    const rank = (s: string) => (s === 'failed' ? 0 : s === 'paused' ? 2 : 1);
    items.sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name));
    return { error: '', live: true, items };
  } catch (e) {
    const status = (e as { status?: number }).status;
    return { error: e instanceof Unpaired ? '' : status === 404 ? 'This connector or Hermes does not list routines yet.' : message(e), live: false, items: [] };
  }
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
    const l = await state(storage);
    await Promise.all([INBOX_CACHE, ...l.cached.map(threadCache)].map((path) => storage.fs.rm(path).catch(() => {})));
    local = fresh();
    await save(storage);
    sessionsSeen = []; cardsSeen = []; cardsLive = false;
    steers.clear(); undelivered.clear(); rowsSeen.clear(); steeredRun.clear();
    return ok;
  },
  inbox: ([, , showSettled, showSnoozed, query, now], store, storage) => { setClock(now); return inbox(showSettled, showSnoozed, query, now, store, storage); },
  snooze: async ([sessionId, until], _store, storage) => {
    const l = await state(storage);
    l.snoozed = until > 0 ? snoozeSession(l.snoozed, sessionId, until) : unsnoozeSession(l.snoozed, sessionId);
    await save(storage);
    return ok;
  },
  savedInbox: ([paired, showSettled, showSnoozed, query, now], _store, storage) => savedInbox(paired, showSettled, showSnoozed, query, now, storage),
  card: ([id], _store, storage) => cardView(id, storage),
  transcript: ([sessionId, , now], store, storage) => { setClock(now); return transcript(sessionId, now, store, storage); },
  savedTranscript: ([sessionId], _store, storage) => savedTranscript(sessionId, storage),
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
      const runId = l.runs[sessionId];
      if (runId) steers.delete(runId);
      undelivered.delete(sessionId); rowsSeen.delete(sessionId); steeredRun.delete(sessionId);
      for (const ledger of [l.runs, l.read, l.snoozed, l.models]) delete ledger[sessionId];
      l.recent = l.recent.filter((r) => r.id !== sessionId);
      await forgetThread(storage, l, sessionId);
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
  // A steer joins the running turn, as Apollo's "Steer now" does; files go with a new message instead.
  steerRun: async ([runId, sessionId, text], store) => {
    try {
      const body = await api(store, `/v1/runs/${encodeURIComponent(runId)}/steer`, { method: 'POST', body: { input: text } });
      if (body.accepted !== true) throw new Error('Hermes did not take the message. Send it again when the run ends.');
      const sent = text.trim();
      const rows = rowsSeen.get(sessionId) ?? [];
      const waiting = unseen(rows, runId).filter((m) => m.text === sent).length;
      steers.set(runId, [...(steers.get(runId) ?? []), { text: sent, before: said(rows, sent) + waiting }]);
      steeredRun.set(sessionId, runId);
      return ok;
    } catch (e) {
      return failed((e as { code?: string }).code === 'run_not_accepting_steer' ? new Error('The run already finished. Send it as a new message.') : e);
    }
  },
  // The Routines screen's list, asked only while it's open (the inbox reads its own row).
  routines: async ([open, , now], store) => (open ? routines(store, now) : { error: '', live: false, items: [] }),
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
    if (settle) reopened.delete(cardId); else reopened.add(cardId);
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
