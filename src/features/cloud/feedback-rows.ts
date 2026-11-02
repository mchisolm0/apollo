import type { Card } from '../../../cloud/src/contract.ts';

export const FEEDBACK_FILTERS = { waiting: 'Waiting', bugs: 'Bugs', ideas: 'Ideas', fixed: 'Fixed', all: 'All' } as const;
export type FeedbackFilter = keyof typeof FEEDBACK_FILTERS;

/**
 * Waiting: the player spoke last, so the producer posted the card as an approval.
 * Bugs and ideas go by the title prefix Scryve writes ("Bug: ...", "Idea: ..."), leaving out
 * reports Scryve marked fixed (a `fixed` meta line), which have their own filter, and
 * archived ones, which only All lists.
 */
const isFixed = (card: Card) => card.meta?.fixed !== undefined;
const isActive = (card: Card) => card.state === 'open' && !isFixed(card);

const MATCHES = {
  waiting: (card) => card.kind === 'approval' && card.state === 'open',
  bugs: (card) => card.title.startsWith('Bug:') && isActive(card),
  ideas: (card) => card.title.startsWith('Idea:') && isActive(card),
  fixed: isFixed,
  all: () => true,
} satisfies Record<FeedbackFilter, (card: Card) => boolean>;

/** Feedback cards for one filter, newest report first. Only Archive closes one, so the inbox holds every report but those archived over 7 days ago. */
export function feedbackRows<C extends Card>(cards: readonly C[], filter: FeedbackFilter): C[] {
  return cards
    .filter((card) => card.source === 'feedback' && MATCHES[filter](card))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
