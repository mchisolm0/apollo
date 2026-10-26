// Hooks: a producer hears about a phone's reply right away instead of on its next poll.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CardInput, HookResponse } from '../src/contract';
import type { TokenInfo } from '../src/inbox';
import { ADMIN_SECRET, call, createToken, postCard, respond } from './helpers';

let device: string;
let feedback: { id: string; token: string };
let previews: { id: string; token: string };

const scoped = async (name: string, source: string) =>
  (await call('/admin/tokens', { token: ADMIN_SECRET, body: { role: 'producer', name, scope: { source, urls: [] } } })).json<{ id: string; token: string }>();

const setHook = (id: string, url: string) => call(`/admin/tokens/${id}/hook`, { method: 'PUT', token: ADMIN_SECRET, body: { url } });

const request = (key: string): CardInput => ({
  source: 'feedback',
  key,
  kind: 'approval',
  title: 'Sync sessions',
  actions: [{ id: 'reply', label: 'Reply', input: 'text', repeat: true }],
});

/** Answers every outbound fetch with 204 and keeps what was sent. */
const mockHooks = () => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

beforeAll(async () => {
  device = await createToken('device', 'phone');
  feedback = await scoped('scryve-feedback', 'feedback');
  previews = await scoped('ci-preview', 'preview');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hooks', () => {
  it('nudge only producers that can read the new event, with their secret', async () => {
    const { secret } = await (await setHook(feedback.id, 'https://scryve.test/apollo/events')).json<HookResponse>();
    expect((await setHook(previews.id, 'https://ci.test/hook')).status).toBe(200);
    const card = await postCard(feedback.token, request('hook:1'));
    const fetch = mockHooks();

    expect((await respond(device, card.id, { actionId: 'reply', text: 'Thanks!' })).status).toBe(200);

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://scryve.test/apollo/events');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
    expect(JSON.parse(String(init?.body))).toEqual({ source: 'feedback' });
  });

  it('list the hook URL but never the secret, and stop once cleared', async () => {
    const tokens = await (await call('/admin/tokens', { token: ADMIN_SECRET })).json<TokenInfo[]>();
    expect(tokens.find((t) => t.id === feedback.id)).toMatchObject({ hook: 'https://scryve.test/apollo/events' });
    expect(JSON.stringify(tokens)).not.toContain('apollo_');

    expect((await call(`/admin/tokens/${feedback.id}/hook`, { method: 'DELETE', token: ADMIN_SECRET })).status).toBe(204);
    expect((await call(`/admin/tokens/${previews.id}/hook`, { method: 'DELETE', token: ADMIN_SECRET })).status).toBe(204);
    const card = await postCard(feedback.token, request('hook:2'));
    const fetch = mockHooks();
    await respond(device, card.id, { actionId: 'reply', text: 'Still there?' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('take only https URLs, only on producer tokens', async () => {
    expect((await setHook(feedback.id, 'http://scryve.test/hook')).status).toBe(400);
    const phones = await (await call('/admin/tokens', { token: ADMIN_SECRET })).json<TokenInfo[]>();
    const phone = phones.find((t) => t.role === 'device')!;
    expect((await setHook(phone.id, 'https://scryve.test/hook')).status).toBe(400);
    expect((await setHook('missing', 'https://scryve.test/hook')).status).toBe(404);
    expect((await call('/admin/tokens/x/hook', { method: 'PUT', token: 'wrong', body: { url: 'https://a.test/' } })).status).toBe(401);
  });
});
