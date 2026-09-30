import { Context, Effect, Fiber, Layer, ManagedRuntime } from 'effect';

import { isDraftAttachment, MAX_ATTACHMENTS, type DraftAttachment } from './attachments.ts';

export type QueuedMessage = Readonly<{
  id: string;
  agentId: string;
  sessionId: string;
  createsSession: boolean;
  text: string;
  model?: string;
  instructions?: string;
  attachments: readonly DraftAttachment[];
  createdAt: number;
  state: 'queued' | 'sending' | 'failed';
  attempts: number;
  firstAttemptAt?: number;
  nextAttemptAt?: number;
  acceptedRunId?: string;
  error?: string;
}>;

export type OutboxSnapshot = Readonly<{ loaded: boolean; items: readonly QueuedMessage[]; error?: string }>;
type Checkpoint = Partial<Pick<QueuedMessage, 'attachments' | 'createsSession' | 'acceptedRunId'>>;
export type OutboxDependencies = {
  storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  canSend(message: QueuedMessage): boolean;
  deliver(message: QueuedMessage, checkpoint: (patch: Checkpoint) => Promise<void>, signal: AbortSignal): Promise<string>;
  discardAttachments(attachments: readonly DraftAttachment[]): void;
  referencedMessageIds?(): Promise<readonly string[]>;
  now?: () => number;
};

const OUTBOX_KEY = 'ekho.outbox.v1';
const MAX_QUEUED_MESSAGES = 100;
// Hermes retains idempotency records for 24 hours. Leave an hour for clock skew.
const SAFE_REPLAY_AGE = 23 * 60 * 60 * 1000;
const NEEDS_REVIEW = 'Delivery could not be confirmed. Check this thread before sending this message again.';

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
}

export function decodeOutbox(saved: string | null): readonly QueuedMessage[] {
  if (saved === null) return [];
  const decoded: unknown = JSON.parse(saved);
  const value: unknown = decoded && typeof decoded === 'object' && 'items' in decoded ? decoded.items : decoded;
  if (!Array.isArray(value) || value.length > MAX_QUEUED_MESSAGES) throw new Error('Saved outbox is invalid.');
  const ids = new Set<string>();
  return value.map((item: unknown): QueuedMessage => {
    if (!item || typeof item !== 'object') throw new Error('Saved outbox is invalid.');
    const entry = item as Record<string, unknown>;
    if (!isId(entry.id) || ids.has(entry.id) || !isId(entry.agentId) || !isId(entry.sessionId)
      || typeof entry.createsSession !== 'boolean' || typeof entry.text !== 'string' || entry.text.length > 8000
      || !Array.isArray(entry.attachments) || entry.attachments.length > MAX_ATTACHMENTS || !entry.attachments.every(isDraftAttachment)
      || (!entry.text.trim() && !entry.attachments.length)
      || typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)
      || !['queued', 'sending', 'failed'].includes(String(entry.state))
      || typeof entry.attempts !== 'number' || !Number.isInteger(entry.attempts) || entry.attempts < 0
      || (entry.firstAttemptAt !== undefined && (typeof entry.firstAttemptAt !== 'number' || !Number.isFinite(entry.firstAttemptAt)))
      || (entry.nextAttemptAt !== undefined && (typeof entry.nextAttemptAt !== 'number' || !Number.isFinite(entry.nextAttemptAt)))
      || (entry.acceptedRunId !== undefined && !isId(entry.acceptedRunId))
      || (entry.model !== undefined && !isId(entry.model))
      || (entry.instructions !== undefined && (typeof entry.instructions !== 'string' || entry.instructions.length > 32000))
      || (entry.error !== undefined && typeof entry.error !== 'string')) throw new Error('Saved outbox is invalid.');
    ids.add(entry.id);
    return { ...entry, state: entry.state === 'sending' ? 'queued' : entry.state } as QueuedMessage;
  });
}

/** The first pending message owns its thread until it is delivered or removed. */
export function readyMessages(items: readonly QueuedMessage[], now: number): readonly QueuedMessage[] {
  const threads = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify([item.agentId, item.sessionId]);
    if (threads.has(key)) return false;
    threads.add(key);
    return item.state === 'queued' && (item.nextAttemptAt ?? 0) <= now;
  });
}

export function canReplayMessage(item: QueuedMessage, now: number): boolean {
  return item.acceptedRunId !== undefined || item.firstAttemptAt === undefined || (now >= item.firstAttemptAt && now - item.firstAttemptAt < SAFE_REPLAY_AGE);
}

function retryable(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return true;
}

class OutboxEnvironment extends Context.Tag('ekho/OutboxEnvironment')<OutboxEnvironment, OutboxDependencies>() {}

/** Owns durable queue mutations and concurrent delivery, with one in-flight message per thread. */
export function createOutboxRuntime(dependencies: OutboxDependencies) {
  const runtime = ManagedRuntime.make(Layer.succeed(OutboxEnvironment, dependencies));
  const mutex = Effect.unsafeMakeSemaphore(1);
  const listeners = new Set<() => void>();
  const inFlight = new Map<string, AbortController>();
  const discardOnFinish = new Map<string, readonly DraftAttachment[]>();
  let snapshot: OutboxSnapshot = { loaded: false, items: [] };
  let worker: Fiber.RuntimeFiber<never, never> | undefined;
  let disposed = false;
  // Receipts protect stale prepared drafts after failed cleanup or a crash.
  let completed = new Set<string>();
  const now = dependencies.now ?? Date.now;

  function publish(next: OutboxSnapshot) {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }
  const save = (items: readonly QueuedMessage[], receipts = completed) => Effect.gen(function* () {
    const env = yield* OutboxEnvironment;
    if (receipts.size > 256 && env.referencedMessageIds) {
      const readIds = env.referencedMessageIds;
      receipts = yield* Effect.tryPromise(() => readIds()).pipe(
        Effect.map((ids) => new Set([...receipts].filter((id) => ids.includes(id)))),
        // An unreadable draft must never lose its protection against duplicate delivery.
        Effect.orElseSucceed(() => receipts),
      );
    }
    yield* Effect.tryPromise(() => env.storage.setItem(OUTBOX_KEY, JSON.stringify({ items, completed: [...receipts] })));
    completed = receipts;
    publish({ loaded: true, items });
  });
  const mutate = (update: (items: readonly QueuedMessage[]) => readonly QueuedMessage[]) => mutex.withPermits(1)(Effect.gen(function* () {
    if (!snapshot.loaded) return yield* Effect.fail(new Error('The outbox has not loaded. Try again.'));
    const items = yield* Effect.try(() => update(snapshot.items));
    yield* save(items);
  }).pipe(Effect.uninterruptible));

  const load = mutex.withPermits(1)(Effect.gen(function* () {
    if (snapshot.loaded) return;
    const env = yield* OutboxEnvironment;
    const saved = yield* Effect.tryPromise({ try: () => env.storage.getItem(OUTBOX_KEY), catch: () => new Error('Could not restore the outbox. Retry before sending a new message.') });
    const { items, receipts } = yield* Effect.try(() => {
      const items = decodeOutbox(saved);
      const value: unknown = saved ? JSON.parse(saved) : null;
      const receipts: unknown = value && typeof value === 'object' && 'completed' in value ? value.completed : [];
      if (!Array.isArray(receipts) || !receipts.every(isId)) throw new Error('Saved delivery receipts are invalid.');
      return { items, receipts };
    });
    completed = new Set(receipts);
    publish({ loaded: true, items });
  }));
  const recordError = (error: unknown) => Effect.sync(() => publish({
    ...snapshot,
    items: snapshot.items.map((item) => item.state === 'sending' && !inFlight.has(item.id) ? { ...item, state: 'queued', nextAttemptAt: now() + 30_000 } : item),
    error: error instanceof Error ? error.message : 'Could not save the outbox. Your draft has been kept.',
  }));

  const deliver = (message: QueuedMessage) => Effect.gen(function* () {
    const env = yield* OutboxEnvironment;
    if (inFlight.has(message.id) || (!message.acceptedRunId && !env.canSend(message))) return;
    const controller = new AbortController();
    inFlight.set(message.id, controller);
    yield* Effect.gen(function* () {
      if (!canReplayMessage(message, now())) {
        yield* mutate((items) => items.map((item) => item.id === message.id ? { ...item, state: 'failed', error: NEEDS_REVIEW } : item));
        return;
      }
      let current = { ...message, state: 'sending' as const, attempts: message.attempts + 1, firstAttemptAt: message.firstAttemptAt ?? now() };
      yield* mutate((items) => items.map((item) => item.id === message.id ? current : item));
      // A canceled queue entry must never be resurrected by a late network callback.
      if (!snapshot.items.some((item) => item.id === message.id)) return;
      const checkpoint = (patch: Checkpoint) => runtime.runPromise(mutate((items) => {
        current = { ...current, ...patch };
        return items.map((item) => item.id === message.id ? current : item);
      }));
      const result = yield* Effect.either(Effect.tryPromise({
        try: (signal) => {
          signal.addEventListener('abort', () => controller.abort(), { once: true });
          if (signal.aborted) controller.abort();
          return current.acceptedRunId ? Promise.resolve(current.acceptedRunId) : env.deliver(current, checkpoint, controller.signal);
        },
        catch: (error) => error,
      }));
      if (controller.signal.aborted) return;
      if (result._tag === 'Right') {
        // Persist acceptance before cleanup, so a failed cleanup never resends a turn.
        yield* Effect.tryPromise(() => checkpoint({ acceptedRunId: result.right }));
        yield* mutex.withPermits(1)(Effect.suspend(() => save(snapshot.items.filter((item) => item.id !== message.id), new Set([...completed, message.id]))).pipe(Effect.uninterruptible));
        env.discardAttachments(current.attachments);
      } else {
        const queued = retryable(result.left) && current.attempts < 5;
        const error = result.left instanceof Error ? result.left.message : 'Could not send this message.';
        yield* mutate((items) => items.map((item) => item.id === message.id ? {
          ...item, state: queued ? 'queued' : 'failed', error,
          nextAttemptAt: queued ? now() + Math.min(1000 * 2 ** current.attempts, 30_000) : undefined,
        } : item));
      }
    }).pipe(Effect.ensuring(Effect.sync(() => {
      inFlight.delete(message.id);
      const files = discardOnFinish.get(message.id);
      if (files) dependencies.discardAttachments(files);
      discardOnFinish.delete(message.id);
    })));
  });

  const drain = Effect.gen(function* () {
    yield* load;
    yield* Effect.forEach(readyMessages(snapshot.items, now()), (item) => deliver(item).pipe(Effect.catchAll(recordError)), { concurrency: 3 });
  }).pipe(Effect.catchAll(recordError));

  function run<A, E>(effect: Effect.Effect<A, E, OutboxEnvironment>) {
    if (disposed) return Promise.reject(new Error('The outbox is closed.'));
    return runtime.runPromise(effect);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: () => run(load.pipe(Effect.tapError(recordError))),
    start: () => {
      if (!worker && !disposed) worker = runtime.runFork(Effect.forever(drain.pipe(Effect.andThen(Effect.sleep('1 second')))));
    },
    drain: () => run(drain),
    enqueue: (input: Pick<QueuedMessage, 'id' | 'agentId' | 'sessionId' | 'createsSession' | 'text' | 'attachments' | 'model' | 'instructions'>) => run(Effect.gen(function* () {
      yield* load;
      const message: QueuedMessage = { ...input, createdAt: now(), attempts: 0, state: 'queued' };
      // Apply the same trust-boundary validation to new and restored messages.
      yield* Effect.try(() => decodeOutbox(JSON.stringify([message])));
      yield* mutate((items) => {
        if (completed.has(message.id)) return items;
        const existing = items.find((item) => item.id === message.id);
        if (existing) {
          if (existing.agentId !== message.agentId || existing.sessionId !== message.sessionId || existing.text !== message.text || existing.model !== message.model || existing.instructions !== message.instructions
            || JSON.stringify(existing.attachments.map((file) => file.id)) !== JSON.stringify(message.attachments.map((file) => file.id))) {
            throw new Error('A different message already uses this delivery identity. Edit the draft before sending.');
          }
          return items;
        }
        if (items.length >= MAX_QUEUED_MESSAGES) throw new Error('The outbox is full. Remove or send a queued message first.');
        return [...items, message];
      });
      return message;
    }).pipe(Effect.tapError(recordError))),
    retry: (id: string) => run(mutate((items) => items.map((item) => {
      if (item.id !== id || inFlight.has(id)) return item;
      if (!canReplayMessage(item, now())) throw new Error(NEEDS_REVIEW);
      return { ...item, state: 'queued', attempts: 0, nextAttemptAt: undefined, error: undefined };
    }))),
    remove: (id: string) => run(Effect.gen(function* () {
      if (inFlight.has(id)) return yield* Effect.fail(new Error('This message is being sent. Wait for delivery before removing it.'));
      const item = snapshot.items.find((item) => item.id === id);
      yield* mutate((items) => items.filter((item) => item.id !== id));
      if (item) dependencies.discardAttachments(item.attachments);
    })),
    forgetAgent: (agentId: string) => run(Effect.gen(function* () {
      const removed = snapshot.items.filter((item) => item.agentId === agentId);
      yield* mutate((items) => items.filter((item) => item.agentId !== agentId));
      removed.forEach((item) => {
        const controller = inFlight.get(item.id);
        if (controller) {
          discardOnFinish.set(item.id, item.attachments);
          controller.abort();
        } else dependencies.discardAttachments(item.attachments);
      });
    }).pipe(Effect.tapError((error) => Effect.sync(() => publish({
      ...snapshot, error: error instanceof Error ? error.message : 'Could not remove queued messages. Retrying cleanup.',
    }))))),
    dispose: async () => {
      disposed = true;
      if (worker) await Effect.runPromise(Fiber.interrupt(worker));
      await runtime.dispose();
      listeners.clear();
    },
  };
}
