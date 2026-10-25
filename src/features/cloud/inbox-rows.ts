import type { Card, CardResponse } from '../../../cloud/src/contract.ts';
import type { InboxSession } from '../relay/session-inbox.ts';
import { parseApolloLink } from './card-text.ts';

/**
 * A card as the inbox shows it: queued responses applied on top of the server's copy.
 * `pendingAction` is an action still on its way. A morning card stays open after Keep or
 * Skip so its picks stay tappable; `acknowledged` is its `resolution`, or a queued action.
 * A `repeat` action never answers the card, so on its way it only sets `sending`. A text
 * reply instead joins `replies` until the producer writes it into the body.
 */
export type InboxCard = Card & { pendingAction?: string; acknowledged?: string; sending?: boolean; replies?: readonly string[] };

/** A reply the server took, with the body it was taken against, shown until the producer re-posts the card with it. */
export type DeliveredReply = Readonly<{ key: string; cardId: string; text: string; body?: string }>;

// A producer may clip a long reply, so only its start has to appear.
const absorbed = (card: Card, reply: DeliveredReply) => card.body !== reply.body && (card.body ?? '').includes(reply.text.slice(0, 100));

/** The replies no card has absorbed yet. Dropping absorbed ones for good keeps a reply that later scrolls out of the body from coming back. */
export function unabsorbedReplies(cards: readonly Card[], delivered: readonly DeliveredReply[]): readonly DeliveredReply[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const left = delivered.filter((reply) => {
    const card = byId.get(reply.cardId);
    return !card || !absorbed(card, reply);
  });
  return left.length === delivered.length ? delivered : left;
}

/** Overlays responses that have not reached the server yet, so taps show immediately and survive offline. */
export function withPendingResponses(cards: readonly Card[], pending: readonly { key?: string; cardId: string; response: CardResponse }[], delivered: readonly DeliveredReply[] = []): InboxCard[] {
  const deliveredKeys = new Set(delivered.map((reply) => reply.key));
  return cards.map((card) => {
    const waiting = delivered.filter((reply) => reply.cardId === card.id && !absorbed(card, reply)).map((reply) => reply.text);
    const base: InboxCard = waiting.length ? { ...card, replies: waiting } : card;
    const overlaid = pending.reduce<InboxCard>((current, { key, cardId, response }) => {
      if (cardId !== current.id || (key !== undefined && deliveredKeys.has(key))) return current;
      if (response.actionId !== undefined) {
        if (current.actions?.some((action) => action.id === response.actionId && action.repeat)) {
          return response.text ? { ...current, replies: [...current.replies ?? [], response.text] } : { ...current, sending: true };
        }
        return current.kind === 'briefing' ? { ...current, acknowledged: response.actionId } : { ...current, pendingAction: response.actionId };
      }
      return { ...current, picks: current.picks?.map((pick) => pick.n === response.pick ? { ...pick, done: response.done } : pick) };
    }, base);
    // The server's first answer wins over a queued one; the queued one shows until it lands.
    const ack = card.resolution?.actionId ?? overlaid.acknowledged;
    return card.kind === 'briefing' && ack ? { ...overlaid, acknowledged: ack } : overlaid;
  });
}

export type InboxRowSession = Pick<InboxSession, 'id' | 'title' | 'preview' | 'settled' | 'status' | 'pendingApproval' | 'activityAt'>;
export type CollapsibleSectionId = 'snoozed' | 'settled';

export type InboxRow<S extends InboxRowSession = InboxRowSession> =
  | { kind: 'briefing'; id: string; card: InboxCard }
  | { kind: 'section'; id: CollapsibleSectionId; title: string; count?: number }
  | { kind: 'caughtUp'; id: 'caught-up' }
  | { kind: 'card'; id: string; card: InboxCard; settled: boolean }
  | { kind: 'session'; id: string; session: S };

const cardTime = (card: Card, field: 'createdAt' | 'updatedAt' = 'updatedAt') => Date.parse(card[field]) / 1000;
const newestFirst = (field: 'createdAt' | 'updatedAt') => (a: Card, b: Card) => cardTime(b, field) - cardTime(a, field);

/** Cards this phone settled: id -> the card's rev at the time. */
export type SettledCards = ReadonlyMap<string, number>;
export const NO_SETTLED: SettledCards = new Map();
const NO_RUNS: ReadonlySet<string> = new Set();

/**
 * A card leaves the open list once the server closes it, or while it still has the rev this
 * phone settled it at. A producer re-upsert (a new digest, a re-posted approval) resurfaces it.
 */
export function isCardSettled(card: Pick<Card, 'id' | 'state' | 'rev'>, settledCards: SettledCards): boolean {
  return card.state !== 'open' || settledCards.get(card.id) === card.rev;
}

/** What a swipe may do: settle an open card, or reopen one this phone settled. An open approval is never settled, since its producer is waiting. */
export function settleAction(card: Pick<Card, 'id' | 'state' | 'rev' | 'kind'>, settledCards: SettledCards): 'settle' | 'reopen' | undefined {
  if (card.state !== 'open') return undefined;
  if (isCardSettled(card, settledCards)) return 'reopen';
  return card.kind === 'approval' ? undefined : 'settle';
}

/**
 * What opening a card does. A link-only update opens its link; anything else opens the
 * detail screen. Opening an update settles it, since its history lives in the producer's
 * Hermes thread; approvals and morning cards stay until answered.
 */
export function cardOpenPlan(card: Pick<Card, 'kind' | 'url' | 'body'>): { target: 'link' | 'detail'; settle: boolean } {
  return { target: card.kind === 'update' && card.url && !card.body ? 'link' : 'detail', settle: card.kind === 'update' };
}

/** The thread and run a Hermes approval card belongs to: from its `apollo://session` url and its `<runId>:<requestId>` key. */
export function hermesApprovalTarget(card: Pick<Card, 'key' | 'url'>): { sessionId?: string; runId?: string } {
  const link = card.url ? parseApolloLink(card.url) : undefined;
  const runId = card.key.includes(':') ? card.key.slice(0, card.key.indexOf(':')) : undefined;
  return { ...(link?.kind === 'session' ? { sessionId: link.id } : {}), ...(runId ? { runId } : {}) };
}

/**
 * Settle-on-open for a detail screen: decides once per card per mount, the first time the
 * screen sees it, settled or not. `seen` is the id already decided. A card that was already
 * settled when the screen opened, or that the user reopens there, is left alone.
 */
export function settleOnFirstSight(seen: string | undefined, card: Pick<Card, 'id' | 'kind' | 'state' | 'rev' | 'url' | 'body'> | undefined, settledCards: SettledCards): { seen: string | undefined; settle: boolean } {
  if (!card || card.id === seen) return { seen, settle: false };
  return { seen: card.id, settle: cardOpenPlan(card).settle && settleAction(card, settledCards) === 'settle' };
}

/** The next ledger after settling or reopening `cardId`, keeping only cards still in the inbox. */
export function updateSettledCards(current: SettledCards, cards: readonly Pick<Card, 'id' | 'rev'>[], cardId: string, settle: boolean): SettledCards {
  const revs = new Map(cards.map((card) => [card.id, card.rev]));
  const next = new Map([...current].filter(([id, rev]) => id !== cardId && revs.get(id) === rev));
  const rev = revs.get(cardId);
  if (settle && rev !== undefined) next.set(cardId, rev);
  return next;
}

export function parseSettledCards(value: unknown): SettledCards {
  if (!value || typeof value !== 'object') return NO_SETTLED;
  return new Map(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
}

/**
 * The open morning card leads, then approvals and waiting threads. Other open threads and
 * update cards interleave by activity. Updates older than three days display as settled.
 * Snoozed and Settled collapse; Settled mixes threads and cards by activity.
 *
 * Hermes cards are approvals the connector posts for any run, including ones started on
 * Discord, by cron or on another device. An open one shows as an approval unless the phone's
 * run state is live (`runStateLive`, the agent is connected) and already shows that thread
 * waiting in the open list or that run in `pendingRunIds`; then the thread row stands for it.
 * Stale run state from an offline agent never hides a card, since its Approve can't land. Closed Hermes cards stay out of Settled; the
 * thread keeps that history. Search hides the morning card; attention keeps open response
 * cards and threads needing attention.
 */
export function buildInboxRows<S extends InboxRowSession>({ sessions, cards, isSnoozed, settledCards = NO_SETTLED, pendingRunIds = NO_RUNS, runStateLive = false, fresh = true, query = '', attentionOnly = false, collapsed, now = Date.now() }: {
  sessions: readonly S[];
  cards: readonly InboxCard[];
  /** Runs this phone knows are waiting for approval. */
  pendingRunIds?: ReadonlySet<string>;
  /** True while the agent is connected, so `pendingRunIds` and pending threads are current. */
  runStateLive?: boolean;
  /**
   * False while sessions or cards still come from cache. Section counts are left out and no
   * "caught up" row is shown, so nothing on screen changes when the live data lands.
   */
  fresh?: boolean;
  isSnoozed: (sessionId: string) => boolean;
  settledCards?: SettledCards;
  query?: string;
  attentionOnly?: boolean;
  collapsed: Readonly<Record<CollapsibleSectionId, boolean>>;
  /** Current time in milliseconds, refreshed by the inbox even without new data. */
  now?: number;
}): InboxRow<S>[] {
  const search = query.trim().toLocaleLowerCase();
  const matches = (...parts: (string | undefined)[]) => !search || parts.join(' ').toLocaleLowerCase().includes(search);
  const expanded = (id: CollapsibleSectionId) => Boolean(search) || !collapsed[id];
  const bucket = (session: S) => session.settled ? 'settled' : isSnoozed(session.id) ? 'snoozed' : 'open';
  // Only a waiting thread that is actually on screen (open, not snoozed) may stand for a card.
  const waitingSessions = new Set(sessions.filter((session) => session.pendingApproval && bucket(session) === 'open').map((session) => session.id));
  const knownLocally = (card: InboxCard) => {
    if (!runStateLive) return false;
    const { sessionId, runId } = hermesApprovalTarget(card);
    return (sessionId !== undefined && waitingSessions.has(sessionId)) || (runId !== undefined && pendingRunIds.has(runId));
  };
  // shortcut: age-out overrides Reopen; add a local reopen override if aged updates must return to Open.
  const settledForDisplay = (card: InboxCard) => isCardSettled(card, settledCards) || (card.kind === 'update' && now / 1000 - cardTime(card) > 3 * 24 * 60 * 60);
  const shown = cards.filter((card) => card.source !== 'hermes');
  const hermes = cards.filter((card) => card.source === 'hermes' && card.kind === 'approval' && !isCardSettled(card, settledCards) && !knownLocally(card));
  const open = [...shown.filter((card) => !settledForDisplay(card)), ...hermes];
  const inBucket = (id: 'open' | 'snoozed' | 'settled') => sessions.filter((session) => bucket(session) === id && matches(session.title, session.preview));

  const briefing = search ? undefined : open.filter((card) => card.kind === 'briefing').sort(newestFirst('createdAt'))[0];
  const approvals = open.filter((card) => card.kind === 'approval' && matches(card.title, card.body)).sort(newestFirst('createdAt'));
  const threads = inBucket('open').filter((session) => !attentionOnly || session.status === 'attention' || session.pendingApproval);
  const waiting = threads.filter((session) => session.pendingApproval);
  const updates = attentionOnly ? [] : open.filter((card) => card.kind === 'update' && matches(card.title, card.body));

  const sessionRow = (session: S): InboxRow<S> => ({ kind: 'session', id: session.id, session });
  const cardRow = (settled: boolean) => (card: InboxCard): InboxRow<S> => ({ kind: 'card', id: card.id, card, settled });
  const rows: InboxRow<S>[] = [
    ...(briefing ? [{ kind: 'briefing' as const, id: briefing.id, card: briefing }] : []),
    ...approvals.map(cardRow(false)),
    ...waiting.map(sessionRow),
    ...[
      ...updates.map((card) => ({ at: cardTime(card), row: cardRow(false)(card) })),
      ...threads.filter((session) => !session.pendingApproval).map((session) => ({ at: session.activityAt, row: sessionRow(session) })),
    ].sort((a, b) => b.at - a.at).map((entry) => entry.row),
  ];
  if (attentionOnly) return rows;
  // Nothing open but something snoozed or settled: say so above those sections.
  const nothingOpen = fresh && !search && rows.length === 0;

  const snoozed = inBucket('snoozed');
  if (snoozed.length) {
    rows.push({ kind: 'section', id: 'snoozed', title: 'Snoozed', ...(fresh ? { count: snoozed.length } : {}) });
    if (expanded('snoozed')) rows.push(...snoozed.map(sessionRow));
  }
  const settled = [
    ...inBucket('settled').map((session) => ({ at: session.activityAt, row: sessionRow(session) })),
    ...shown.filter((card) => settledForDisplay(card) && matches(card.title, card.body)).map((card) => ({ at: cardTime(card), row: cardRow(true)(card) })),
  ].sort((a, b) => b.at - a.at);
  if (settled.length) {
    rows.push({ kind: 'section', id: 'settled', title: 'Settled', ...(fresh ? { count: settled.length } : {}) });
    if (expanded('settled')) rows.push(...settled.map((entry) => entry.row));
  }
  if (nothingOpen && rows.length) rows.unshift({ kind: 'caughtUp', id: 'caught-up' });
  return rows;
}
