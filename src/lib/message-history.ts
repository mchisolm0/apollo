import type { HermesMessage } from './types.ts';

/** Retain accepted local sends until durable history contains their occurrence. */
export function reconcileHistory(current: readonly HermesMessage[], loaded: readonly HermesMessage[]): readonly HermesMessage[] {
  // Session history is append-only. A shorter snapshot can arrive after a newer
  // load too, when the optimistic IDs have already been replaced by server IDs.
  // Hermes returns only the latest page of a long thread, so older turns can leave a
  // newer snapshot. Past the newest saved message, count only local sends and what
  // Hermes saved since.
  const known = current.reduce<number | undefined>((newest, message) => message.sequence !== undefined && (newest === undefined || message.sequence > newest) ? message.sequence : newest, undefined);
  const userCount = (messages: readonly HermesMessage[]) => messages.filter((message) => message.role === 'user'
    && (known === undefined || message.sequence === undefined || message.sequence > known)).length;
  return userCount(loaded) < userCount(current) ? current : loaded;
}
