import type { Card, CardResponse } from '../../../cloud/src/contract.ts';

/** One user intent waiting to reach `POST /v1/cards/:id/respond`. `key` is its Idempotency-Key. */
export type QueuedResponse = Readonly<{
  key: string;
  cardId: string;
  response: CardResponse;
  createdAt: number;
  attempts: number;
  nextAttemptAt?: number;
}>;

export type RespondQueueSnapshot = Readonly<{ items: readonly QueuedResponse[]; error?: string }>;

export type RespondQueueDependencies = {
  storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  send(item: QueuedResponse): Promise<Card>;
  now?: () => number;
};

type Failure = { status?: number; code?: string; card?: Card; message?: string };

const STORAGE_KEY = 'apollo.cloud-responses.v1';
const MAX_ITEMS = 100;
// The Worker keeps idempotency records for 24 hours. Replaying later could record twice.
const MAX_AGE_MS = 23 * 60 * 60 * 1000;

function failureOf(error: unknown): Failure {
  return error && typeof error === 'object' ? error : {};
}

function isResponse(value: unknown): value is CardResponse {
  if (!value || typeof value !== 'object') return false;
  if ('actionId' in value) return typeof value.actionId === 'string' && !('pick' in value);
  return 'pick' in value && 'done' in value && typeof value.pick === 'number' && typeof value.done === 'boolean';
}

function isQueued(value: unknown): value is QueuedResponse {
  return Boolean(value) && typeof value === 'object' && value !== null
    && 'key' in value && typeof value.key === 'string' && 'cardId' in value && typeof value.cardId === 'string'
    && 'response' in value && isResponse(value.response)
    && 'createdAt' in value && typeof value.createdAt === 'number' && 'attempts' in value && typeof value.attempts === 'number';
}

function parseItems(saved: string | null): QueuedResponse[] {
  if (!saved) return [];
  const value: unknown = JSON.parse(saved);
  return Array.isArray(value) ? value.filter(isQueued).slice(-MAX_ITEMS) : [];
}

function samePick(a: CardResponse, b: CardResponse) {
  return 'pick' in a && 'pick' in b && a.pick === b.pick;
}

/**
 * A durable queue of card responses, strictly first in, first out per card: a later
 * response for a card waits behind that card's head, even while the head backs off, so a
 * Keep can never overtake a pick and an old toggle never lands after a newer one.
 * `409 card_closed` counts as delivered: someone else answered first and the server's card
 * goes to `onCard` listeners like any other result.
 */
export function createRespondQueue(dependencies: RespondQueueDependencies) {
  const now = dependencies.now ?? Date.now;
  const listeners = new Set<() => void>();
  const cardListeners = new Set<(card: Card) => void>();
  let snapshot: RespondQueueSnapshot = { items: [] };
  let loading: Promise<void> | undefined;
  let flushing: Promise<void> | undefined;
  let again = false;
  let inFlight: string | undefined;
  let lock = Promise.resolve();

  const publish = (items: readonly QueuedResponse[], error = snapshot.error) => {
    snapshot = { items, ...(error ? { error } : {}) };
    listeners.forEach((listener) => listener());
  };
  /** Serializes read-modify-write so concurrent enqueues and deliveries never drop each other. */
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = lock.then(run);
    lock = next.then(() => undefined, () => undefined);
    return next;
  };
  const persist = (items: readonly QueuedResponse[]) => dependencies.storage.setItem(STORAGE_KEY, JSON.stringify(items));
  /** Removing or rescheduling a delivered item is best effort: a replay is safe under its idempotency key. */
  const update = (change: (items: readonly QueuedResponse[]) => readonly QueuedResponse[], error?: string) => exclusive(async () => {
    const items = change(snapshot.items);
    publish(items, error);
    await persist(items).catch(() => undefined);
  });
  const load = () => loading ??= dependencies.storage.getItem(STORAGE_KEY)
    .then((saved) => {
      let restored: QueuedResponse[] = [];
      try { restored = parseItems(saved); } catch { /* A corrupt queue cannot be replayed safely. */ }
      publish(restored);
    })
    .catch(() => undefined);

  const without = (key: string) => (items: readonly QueuedResponse[]) => items.filter((item) => item.key !== key);

  const deliverOnce = async () => {
    const at = now();
    if (snapshot.items.some((item) => item.key !== inFlight && at - item.createdAt > MAX_AGE_MS)) {
      await update((items) => items.filter((item) => item.key === inFlight || at - item.createdAt <= MAX_AGE_MS), 'Some responses could not be delivered in time.');
    }
    const seen = new Set<string>();
    const item = snapshot.items.find((candidate) => {
      const head = !seen.has(candidate.cardId);
      seen.add(candidate.cardId);
      return head && (candidate.nextAttemptAt ?? 0) <= at;
    });
    if (!item) return false;
    inFlight = item.key;
    try {
      const card = await dependencies.send(item);
      await update(without(item.key));
      cardListeners.forEach((listener) => listener(card));
    } catch (error) {
      const failure = failureOf(error);
      if (failure.status === 409 && failure.code === 'card_closed') {
        await update(without(item.key));
        const { card } = failure;
        if (card) cardListeners.forEach((listener) => listener(card));
      } else if (failure.status === undefined || failure.status === 408 || failure.status === 429 || failure.status >= 500) {
        const attempts = item.attempts + 1;
        const nextAttemptAt = now() + Math.min(1000 * 2 ** attempts, 60_000);
        await update((items) => items.map((candidate) => candidate.key === item.key ? { ...candidate, attempts, nextAttemptAt } : candidate));
      } else {
        await update(without(item.key), failure.message ?? 'A response was rejected.');
      }
    } finally {
      inFlight = undefined;
    }
    return true;
  };

  const flush = (): Promise<void> => {
    if (flushing) {
      again = true;
      return flushing;
    }
    flushing = (async () => {
      await load();
      do {
        again = false;
        while (await deliverOnce()) { /* keep draining */ }
      } while (again);
    })().finally(() => { flushing = undefined; });
    return flushing;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** Called with the server's current card after each delivered or already-closed response. */
    onCard(listener: (card: Card) => void) {
      cardListeners.add(listener);
      return () => { cardListeners.delete(listener); };
    },
    load,
    flush,
    /**
     * Adds one intent and resolves only once it is saved; it rejects if storage fails, so
     * the caller can keep the card actionable. Re-enqueueing a key is a no-op. A pick for
     * the same card and pick as an unsent entry updates that entry in place: it keeps its
     * key when the body is unchanged and takes the new key when `done` differs.
     */
    enqueue: (input: Pick<QueuedResponse, 'key' | 'cardId' | 'response'>) => load().then(() => exclusive(async () => {
      if (snapshot.items.some((item) => item.key === input.key)) return;
      const pending = snapshot.items.find((item) => item.key !== inFlight && item.cardId === input.cardId && samePick(item.response, input.response));
      const items = !pending ? [...snapshot.items, { ...input, createdAt: now(), attempts: 0 }].slice(-MAX_ITEMS)
        : JSON.stringify(pending.response) === JSON.stringify(input.response) ? snapshot.items
          : snapshot.items.map((item) => item === pending ? { ...item, key: input.key, response: input.response } : item);
      if (items === snapshot.items) return;
      await persist(items);
      publish(items);
    })),
    /** Earliest time a waiting item may be retried, for scheduling the next flush. */
    nextAttemptAt() {
      return snapshot.items.reduce<number | undefined>((earliest, item) => item.nextAttemptAt === undefined ? earliest : Math.min(earliest ?? Infinity, item.nextAttemptAt), undefined);
    },
    clearError() {
      if (snapshot.error) publish(snapshot.items, '');
    },
  };
}

export type RespondQueue = ReturnType<typeof createRespondQueue>;
