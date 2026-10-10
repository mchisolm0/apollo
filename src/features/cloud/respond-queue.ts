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
 * A durable, ordered queue of card responses. Delivery is sequential so picks land in
 * the order they were tapped. `409 card_closed` counts as delivered: someone else answered
 * first and the server's card is passed to `onCard` listeners like any other result.
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
  let write = Promise.resolve();

  const publish = (items: readonly QueuedResponse[], error?: string) => {
    snapshot = { items, ...(error ? { error } : {}) };
    listeners.forEach((listener) => listener());
  };
  const save = (items: readonly QueuedResponse[], error?: string) => {
    publish(items, error);
    write = write.then(() => dependencies.storage.setItem(STORAGE_KEY, JSON.stringify(items))).catch(() => undefined);
    return write;
  };
  const load = () => loading ??= dependencies.storage.getItem(STORAGE_KEY)
    .then((saved) => {
      let restored: QueuedResponse[] = [];
      try { restored = parseItems(saved); } catch { /* A corrupt queue cannot be replayed safely. */ }
      // Anything enqueued before storage answered stays after what was saved.
      publish([...restored, ...snapshot.items.filter((item) => !restored.some((saved) => saved.key === item.key))], snapshot.error);
    })
    .catch(() => undefined);

  const deliverOnce = async () => {
    const at = now();
    const expired = snapshot.items.filter((item) => item.key !== inFlight && at - item.createdAt > MAX_AGE_MS);
    if (expired.length) await save(snapshot.items.filter((item) => !expired.includes(item)), 'Some responses could not be delivered in time.');
    const item = snapshot.items.find((candidate) => (candidate.nextAttemptAt ?? 0) <= at);
    if (!item) return false;
    inFlight = item.key;
    try {
      const card = await dependencies.send(item);
      await save(snapshot.items.filter((candidate) => candidate.key !== item.key), snapshot.error);
      cardListeners.forEach((listener) => listener(card));
    } catch (error) {
      const failure = failureOf(error);
      if (failure.status === 409 && failure.code === 'card_closed') {
        await save(snapshot.items.filter((candidate) => candidate.key !== item.key), snapshot.error);
        const { card } = failure;
        if (card) cardListeners.forEach((listener) => listener(card));
        return true;
      }
      const retry = failure.status === undefined || failure.status === 408 || failure.status === 429 || failure.status >= 500;
      if (!retry) {
        await save(snapshot.items.filter((candidate) => candidate.key !== item.key), failure.message ?? 'A response was rejected.');
        return true;
      }
      const attempts = item.attempts + 1;
      await save(snapshot.items.map((candidate) => candidate.key === item.key
        ? { ...candidate, attempts, nextAttemptAt: now() + Math.min(1000 * 2 ** attempts, 60_000) } : candidate), snapshot.error);
      // A retryable failure (offline, 5xx) applies to everything behind it too.
      return false;
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
     * Adds one intent. Re-enqueueing a key is a no-op. A newer pick for the same card and
     * pick replaces an older one that has not been sent yet, since only the last value matters.
     */
    async enqueue(input: Pick<QueuedResponse, 'key' | 'cardId' | 'response'>) {
      await load();
      if (snapshot.items.some((item) => item.key === input.key)) return;
      const kept = snapshot.items.filter((item) => item.key === inFlight || item.cardId !== input.cardId || !samePick(item.response, input.response));
      await save([...kept, { ...input, createdAt: now(), attempts: 0 }].slice(-MAX_ITEMS));
    },
    /** Earliest time a waiting item may be retried, for scheduling the next flush. */
    nextAttemptAt() {
      return snapshot.items.reduce<number | undefined>((earliest, item) => item.nextAttemptAt === undefined ? earliest : Math.min(earliest ?? Infinity, item.nextAttemptAt), undefined);
    },
    clearError() {
      if (snapshot.error) publish(snapshot.items);
    },
  };
}

export type RespondQueue = ReturnType<typeof createRespondQueue>;
