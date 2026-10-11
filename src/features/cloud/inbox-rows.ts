import type { Card, CardResponse } from '../../../cloud/src/contract.ts';
import type { InboxSession } from '../relay/session-inbox.ts';

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

/** A card leaves the open list once the server closes it or this phone settles it. */
export function isCardSettled(card: Pick<Card, 'id' | 'state'>, settledCards: ReadonlySet<string>): boolean {
  return card.state !== 'open' || settledCards.has(card.id);
}

/**
 * Lays out the home inbox (design A): no labels between cards. The open morning card
 * comes first, then approval cards, then threads (waiting on approval first), then update
 * cards newest first, then the collapsible Snoozed and Settled sections. Settled holds
 * settled threads and closed or locally settled cards, newest first. Cards from `hermes`
 * never get their own row because the thread row already stands for them. Search and the
 * attention filter hide the morning card; the attention filter also hides updates.
 */
export function buildInboxRows<S extends InboxRowSession>({ sessions, cards, isSnoozed, settledCards = new Set(), query = '', attentionOnly = false, collapsed }: {
  sessions: readonly S[];
  cards: readonly InboxCard[];
  isSnoozed: (sessionId: string) => boolean;
  settledCards?: ReadonlySet<string>;
  query?: string;
  attentionOnly?: boolean;
  collapsed: Readonly<Record<CollapsibleSectionId, boolean>>;
}): InboxRow<S>[] {
  const search = query.trim().toLocaleLowerCase();
  const matches = (...parts: (string | undefined)[]) => !search || parts.join(' ').toLocaleLowerCase().includes(search);
  const expanded = (id: CollapsibleSectionId) => Boolean(search) || !collapsed[id];
  const shown = cards.filter((card) => card.source !== 'hermes');
  const open = shown.filter((card) => !isCardSettled(card, settledCards));
  const bucket = (session: S) => session.settled ? 'settled' : isSnoozed(session.id) ? 'snoozed' : 'open';
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
    ...threads.filter((session) => !session.pendingApproval).map(sessionRow),
    ...updates.map(cardRow(false)),
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
