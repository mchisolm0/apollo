import { env, exports } from 'cloudflare:workers';
import { vi } from 'vitest';

import type { Card, CardInput, StreamMessage, TokenRole } from '../src/contract';
import type { expoMessage } from '../src/push';

export const ADMIN_SECRET = 'test-admin-secret';
export const inbox = () => env.INBOX.getByName('owner');

/** Calls the Worker the way a client would. */
export function call(path: string, init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return exports.default.fetch(`https://cloud.test${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export async function createToken(role: TokenRole, name: string) {
  const response = await call('/admin/tokens', { token: ADMIN_SECRET, body: { role, name } });
  const { token } = await response.json<{ token: string }>();
  return token;
}

export async function postCard(token: string, input: CardInput) {
  return (await call('/v1/cards', { token, body: input })).json<Card>();
}

export const respond = (token: string, id: string, body: unknown, key: string = crypto.randomUUID()) =>
  call(`/v1/cards/${id}/respond`, { token, body, headers: { 'idempotency-key': key } });

export const approval = (key: string): CardInput => ({
  source: 'hermes',
  key,
  kind: 'approval',
  title: 'Run rm -rf build?',
  actions: [
    { id: 'approve', label: 'Approve', style: 'primary' },
    { id: 'reject', label: 'Reject', style: 'destructive' },
  ],
});

/** Opens the device stream and collects what arrives. */
export async function openStream(token: string) {
  const response = await call('/v1/stream', { token, headers: { upgrade: 'websocket' } });
  const ws = response.webSocket;
  if (!ws) throw new Error(`stream upgrade failed with ${response.status}`);
  ws.accept();
  const messages: StreamMessage[] = [];
  ws.addEventListener('message', (event) => {
    messages.push(JSON.parse(String(event.data)));
  });
  const closed = new Promise<number>((resolve) => ws.addEventListener('close', (event) => resolve(event.code)));
  return { ws, messages, closed };
}

/** Stands in for the Expo push API. Each call answers with the next queued reply, then `ok` tickets. */
export function mockExpo(...replies: ((tokens: string[]) => Response)[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const messages: { to: string }[] = JSON.parse(String(init?.body));
    const tokens = messages.map((m) => m.to);
    const reply = replies.shift() ?? ((all: string[]) => Response.json({ data: all.map(() => ({ status: 'ok', id: 'ticket' })) }));
    return reply(tokens);
  });
}

/** The JSON body of each Expo request the mock received. */
export const sentPushes = (expo: ReturnType<typeof mockExpo>) =>
  expo.mock.calls.map(([, init]): ReturnType<typeof expoMessage>[] => JSON.parse(String(init?.body)));
