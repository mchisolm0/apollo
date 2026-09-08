import type { HermesMessage } from './types.ts';

/** Retain accepted local sends until durable history contains their occurrence. */
export function reconcileHistory(current: readonly HermesMessage[], loaded: readonly HermesMessage[]): readonly HermesMessage[] {
  // Session history is append-only. A shorter snapshot can arrive after a newer
  // load too, when the optimistic IDs have already been replaced by server IDs.
  const userCount = (messages: readonly HermesMessage[]) => messages.filter((message) => message.role === 'user').length;
  return userCount(loaded) < userCount(current) ? current : loaded;
}
