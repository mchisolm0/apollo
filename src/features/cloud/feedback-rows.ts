import type { Card } from '../../../cloud/src/contract.ts';

export const FEEDBACK_FILTERS = { waiting: 'Waiting', bugs: 'Bugs', ideas: 'Ideas', all: 'All' } as const;
export type FeedbackFilter = keyof typeof FEEDBACK_FILTERS;

/**
 * Waiting: the player spoke last, so the producer posted the card as an approval.
 * Bugs and ideas go by the title prefix Scryve writes ("Bug: ...", "Idea: ...").
 */
const MATCHES = {
  waiting: (card) => card.kind === 'approval' && card.state === 'open',
  bugs: (card) => card.title.startsWith('Bug:'),
  ideas: (card) => card.title.startsWith('Idea:'),
  all: () => true,
} satisfies Record<FeedbackFilter, (card: Card) => boolean>;

/** Feedback cards for one filter, newest report first. Producers never close them, so the inbox holds every one. */
export function feedbackRows<C extends Card>(cards: readonly C[], filter: FeedbackFilter): C[] {
  return cards
    .filter((card) => card.source === 'feedback' && MATCHES[filter](card))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
