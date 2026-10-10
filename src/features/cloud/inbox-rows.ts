import type { Card, CardResponse } from '../../../cloud/src/contract.ts';
import type { InboxSession } from '../relay/session-inbox.ts';

/**
 * A card as the inbox shows it: queued responses applied on top of the server's copy.
 * `pendingAction` is an action still on its way. A morning card stays open after Keep or
 * Skip so its picks stay tappable; `acknowledged` names the action already taken on it.
 */
export type InboxCard = Card & { pendingAction?: string; acknowledged?: string };

/** Overlays responses that have not reached the server yet, so taps show immediately and survive offline. */
export function withPendingResponses(
  cards: readonly Card[],
  pending: readonly { cardId: string; response: CardResponse }[],
  acknowledged: Readonly<Record<string, string>> = {},
): InboxCard[] {
  return cards.map((card) => {
    const overlaid = pending.reduce<InboxCard>((current, { cardId, response }) => {
      if (cardId !== current.id) return current;
      if (response.actionId !== undefined) return current.kind === 'briefing' ? { ...current, acknowledged: response.actionId } : { ...current, pendingAction: response.actionId };
      return { ...current, picks: current.picks?.map((pick) => pick.n === response.pick ? { ...pick, done: response.done } : pick) };
    }, card);
    const ack = overlaid.acknowledged ?? acknowledged[card.id] ?? card.resolution?.actionId;
    return card.kind === 'briefing' && ack ? { ...overlaid, acknowledged: ack } : overlaid;
  });
}

export type InboxRowSession = Pick<InboxSession, 'id' | 'title' | 'preview' | 'settled' | 'status' | 'pendingApproval'>;
export type InboxSectionId = 'needs' | 'threads' | 'updates' | 'snoozed' | 'settled';
export type CollapsibleSectionId = Extract<InboxSectionId, 'updates' | 'snoozed' | 'settled'>;

export type InboxRow<S extends InboxRowSession = InboxRowSession> =
  | { kind: 'briefing'; id: string; card: InboxCard }
  | { kind: 'section'; id: InboxSectionId; title: string; count: number; collapsible: boolean }
  | { kind: 'card'; id: string; card: InboxCard }
  | { kind: 'session'; id: string; session: S };

const newest = (field: 'createdAt' | 'updatedAt') => (a: Card, b: Card) => Date.parse(b[field]) - Date.parse(a[field]);

/**
 * Lays out the home inbox (design C): the open morning card, then Needs you (approval
 * cards and threads waiting on approval), then threads, then collapsible Updates,
 * Snoozed and Settled. Cards from `hermes` never get their own row because the thread
 * row already stands for them. Search and the attention filter hide the morning card.
 */
export function buildInboxRows<S extends InboxRowSession>({ sessions, cards, isSnoozed, query = '', attentionOnly = false, collapsed }: {
  sessions: readonly S[];
  cards: readonly InboxCard[];
  isSnoozed: (sessionId: string) => boolean;
  query?: string;
  attentionOnly?: boolean;
  collapsed: Readonly<Record<CollapsibleSectionId, boolean>>;
}): InboxRow<S>[] {
  const search = query.trim().toLocaleLowerCase();
  const matches = (...parts: (string | undefined)[]) => !search || parts.join(' ').toLocaleLowerCase().includes(search);
  const expanded = (id: CollapsibleSectionId) => Boolean(search) || !collapsed[id];
  const visible = cards.filter((card) => card.source !== 'hermes' && card.state === 'open');
  const bucket = (session: S) => session.settled ? 'settled' : isSnoozed(session.id) ? 'snoozed' : 'open';
  const inBucket = (id: 'open' | 'snoozed' | 'settled') => sessions.filter((session) => bucket(session) === id && matches(session.title, session.preview));

  const briefing = search || attentionOnly ? undefined
    : visible.filter((card) => card.kind === 'briefing').sort(newest('createdAt'))[0];
  const approvals = visible.filter((card) => card.kind === 'approval' && matches(card.title, card.body)).sort(newest('createdAt'));
  const open = inBucket('open');
  const waiting = open.filter((session) => session.pendingApproval);
  const threads = open.filter((session) => !session.pendingApproval && (!attentionOnly || session.status === 'attention'));
  const updates = attentionOnly ? [] : visible.filter((card) => card.kind === 'update' && matches(card.title, card.body)).sort(newest('updatedAt'));

  const rows: InboxRow<S>[] = [];
  const sessionRows = (list: readonly S[]) => list.map((session): InboxRow<S> => ({ kind: 'session', id: session.id, session }));
  const cardRows = (list: readonly InboxCard[]) => list.map((card): InboxRow<S> => ({ kind: 'card', id: card.id, card }));
  if (briefing) rows.push({ kind: 'briefing', id: briefing.id, card: briefing });
  const needs = approvals.length + waiting.length;
  if (needs) rows.push({ kind: 'section', id: 'needs', title: 'Needs you', count: needs, collapsible: false }, ...cardRows(approvals), ...sessionRows(waiting));
  if (threads.length) {
    if (briefing || needs) rows.push({ kind: 'section', id: 'threads', title: 'Threads', count: threads.length, collapsible: false });
    rows.push(...sessionRows(threads));
  }
  if (updates.length) {
    rows.push({ kind: 'section', id: 'updates', title: 'Updates', count: updates.length, collapsible: true });
    if (expanded('updates')) rows.push(...cardRows(updates));
  }
  if (!attentionOnly) {
    for (const [id, title] of [['snoozed', 'Snoozed'], ['settled', 'Settled']] as const) {
      const list = inBucket(id);
      if (!list.length) continue;
      rows.push({ kind: 'section', id, title, count: list.length, collapsible: true });
      if (expanded(id)) rows.push(...sessionRows(list));
    }
  }
  return rows;
}
