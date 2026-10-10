// Expo push delivery. One request per card, one message per recipient.
// Retries are the caller's job: this reports, per recipient, what to do next.
import { CATEGORY, type Card } from './contract';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * tickets: Expo answered. `delivered` and `unregistered` are done for good;
 * `retry` got an error ticket (e.g. MessageRateExceeded) or none at all.
 * retry / failed: the whole request failed, for every recipient.
 */
export type PushOutcome =
  | { status: 'tickets'; delivered: string[]; unregistered: string[]; retry: string[] }
  | { status: 'retry'; reason: string }
  | { status: 'failed'; reason: string };

interface ExpoTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

/**
 * Builds the Expo message for one phone. Passive cards are silent: the iOS
 * passive interruption level and the Android `updates` channel.
 */
export function expoMessage(card: Card, to: string) {
  const passive = card.push === 'passive';
  return {
    to,
    title: card.title,
    body: card.body?.slice(0, 500),
    data: { cardId: card.id, source: card.source, kind: card.kind },
    threadId: card.source,
    categoryId: card.kind === 'update' ? undefined : CATEGORY[card.kind],
    interruptionLevel: passive ? 'passive' : 'active',
    channelId: passive ? 'updates' : 'alerts',
    sound: passive ? null : 'default',
    priority: passive ? 'normal' : 'high',
  };
}

export async function sendPush(card: Card, tokens: string[], accessToken?: string): Promise<PushOutcome> {
  let response: Response;
  try {
    response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(tokens.map((token) => expoMessage(card, token))),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    return { status: 'retry', reason: cause instanceof Error ? cause.message : String(cause) };
  }
  if (response.status === 429 || response.status >= 500) return { status: 'retry', reason: `Expo returned ${response.status}` };
  if (!response.ok) return { status: 'failed', reason: `Expo returned ${response.status}` };

  // Tickets come back in message order, one per recipient.
  const result = await response.json<{ data?: ExpoTicket[] }>().catch(() => ({ data: [] }));
  const tickets = result.data ?? [];
  const outcome: PushOutcome = { status: 'tickets', delivered: [], unregistered: [], retry: [] };
  tokens.forEach((token, i) => {
    const ticket = tickets[i];
    if (ticket?.status === 'ok') outcome.delivered.push(token);
    else if (ticket?.details?.error === 'DeviceNotRegistered') outcome.unregistered.push(token);
    else outcome.retry.push(token);
  });
  return outcome;
}
