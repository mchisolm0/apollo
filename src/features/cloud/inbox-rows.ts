import type { Card, CardResponse } from '../../../cloud/src/contract.ts';
import type { InboxSession } from '../relay/session-inbox.ts';
import { parseApolloLink } from './card-text.ts';

/**
 * A card as the inbox shows it: queued responses applied on top of the server's copy.
 * `pendingAction` is an action still on its way. A morning card stays open after Keep or
 * Skip so its picks stay tappable; `acknowledged` is its `resolution`, or a queued action.
 */
export type InboxCard = Card & { pendingAction?: string; acknowledged?: string };

/** Overlays responses that have not reached the server yet, so taps show immediately and survive offline. */
export function withPendingResponses(cards: readonly Card[], pending: readonly { cardId: string; response: CardResponse }[]): InboxCard[] {
  return cards.map((card) => {
    const overlaid = pending.reduce<InboxCard>((current, { cardId, response }) => {
      if (cardId !== current.id) return current;
      if (response.actionId !== undefined) return current.kind === 'briefing' ? { ...current, acknowledged: response.actionId } : { ...current, pendingAction: response.actionId };
      return { ...current, picks: current.picks?.map((pick) => pick.n === response.pick ? { ...pick, done: response.done } : pick) };
    }, card);
    // The server's first answer wins over a queued one; the queued one shows until it lands.
    const ack = card.resolution?.actionId ?? overlaid.acknowledged;
    return card.kind === 'briefing' && ack ? { ...overlaid, acknowledged: ack } : overlaid;
  });
}

export type InboxRowSession = Pick<InboxSession, 'id' | 'title' | 'preview' | 'settled' | 'status' | 'pendingApproval' | 'activityAt'>;
export type CollapsibleSectionId = 'snoozed' | 'settled';

export type InboxRow<S extends InboxRowSession = InboxRowSession> =
  | { kind: 'briefing'; id: string; card: InboxCard }
  | { kind: 'section'; id: CollapsibleSectionId; title: string; count: number }
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
 * Lays out the home inbox (design A): no labels between cards. Cards are for urgent items
 * that leave once handled, so they sit above ordinary threads: the open morning card, then
 * approval cards, threads waiting on approval, update cards newest first, the remaining
 * threads, and the collapsible Snoozed and Settled sections. Settled holds
 * settled threads and closed or locally settled cards, newest first.
 *
 * Hermes cards are approvals the connector posts for any run, including ones started on
 * Discord, by cron or on another device. An open one shows as an approval unless the phone's
 * run state is live (`runStateLive`, the agent is connected) and already shows that thread
 * waiting in the open list or that run in `pendingRunIds`; then the thread row stands for it.
 * Stale run state from an offline agent never hides a card, since its Approve can't land. Closed Hermes cards stay out of Settled; the
 * thread keeps that history. Search and the attention filter hide the morning card; the
 * attention filter also hides updates.
 */
export function buildInboxRows<S extends InboxRowSession>({ sessions, cards, isSnoozed, settledCards = NO_SETTLED, pendingRunIds = NO_RUNS, runStateLive = false, query = '', attentionOnly = false, collapsed }: {
  sessions: readonly S[];
  cards: readonly InboxCard[];
  /** Runs this phone knows are waiting for approval. */
  pendingRunIds?: ReadonlySet<string>;
  /** True while the agent is connected, so `pendingRunIds` and pending threads are current. */
  runStateLive?: boolean;
  isSnoozed: (sessionId: string) => boolean;
  settledCards?: SettledCards;
  query?: string;
  attentionOnly?: boolean;
  collapsed: Readonly<Record<CollapsibleSectionId, boolean>>;
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
  const shown = cards.filter((card) => card.source !== 'hermes');
  const hermes = cards.filter((card) => card.source === 'hermes' && card.kind === 'approval' && !isCardSettled(card, settledCards) && !knownLocally(card));
  const open = [...shown.filter((card) => !isCardSettled(card, settledCards)), ...hermes];
  const inBucket = (id: 'open' | 'snoozed' | 'settled') => sessions.filter((session) => bucket(session) === id && matches(session.title, session.preview));

  const briefing = search || attentionOnly ? undefined : open.filter((card) => card.kind === 'briefing').sort(newestFirst('createdAt'))[0];
  const approvals = open.filter((card) => card.kind === 'approval' && matches(card.title, card.body)).sort(newestFirst('createdAt'));
  const threads = inBucket('open').filter((session) => !attentionOnly || session.status === 'attention' || session.pendingApproval);
  const waiting = threads.filter((session) => session.pendingApproval);
  const updates = attentionOnly ? [] : open.filter((card) => card.kind === 'update' && matches(card.title, card.body)).sort(newestFirst('updatedAt'));

  const sessionRow = (session: S): InboxRow<S> => ({ kind: 'session', id: session.id, session });
  const cardRow = (settled: boolean) => (card: InboxCard): InboxRow<S> => ({ kind: 'card', id: card.id, card, settled });
  const rows: InboxRow<S>[] = [
    ...(briefing ? [{ kind: 'briefing' as const, id: briefing.id, card: briefing }] : []),
    ...approvals.map(cardRow(false)),
    ...waiting.map(sessionRow),
    ...updates.map(cardRow(false)),
    ...threads.filter((session) => !session.pendingApproval).map(sessionRow),
  ];
  if (attentionOnly) return rows;

  const snoozed = inBucket('snoozed');
  if (snoozed.length) {
    rows.push({ kind: 'section', id: 'snoozed', title: 'Snoozed', count: snoozed.length });
    if (expanded('snoozed')) rows.push(...snoozed.map(sessionRow));
  }
  const settled = [
    ...inBucket('settled').map((session) => ({ at: session.activityAt, row: sessionRow(session) })),
    ...shown.filter((card) => isCardSettled(card, settledCards) && matches(card.title, card.body)).map((card) => ({ at: cardTime(card), row: cardRow(true)(card) })),
  ].sort((a, b) => b.at - a.at);
  if (settled.length) {
    rows.push({ kind: 'section', id: 'settled', title: 'Settled', count: settled.length });
    if (expanded('settled')) rows.push(...settled.map((entry) => entry.row));
  }
  return rows;
}
