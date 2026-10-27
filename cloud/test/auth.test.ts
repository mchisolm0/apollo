import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Card, CardSnapshot, DeviceTokenResponse } from '../src/contract';
import type { TokenInfo } from '../src/inbox';
import { ADMIN_SECRET, approval, call, createToken, inbox, openStream } from './helpers';

let device: string;
let producer: string;
let connector: string;

beforeAll(async () => {
  device = await createToken('device', 'phone');
  producer = await createToken('producer', 'nobara');
  connector = await createToken('connector', 'mini');
});

describe('auth', () => {
  it('lets each role reach only its endpoints', async () => {
    const status = async (path: string, token: string | undefined, body?: unknown) => (await call(path, { token, body })).status;

    expect(await status('/v1/cards', undefined)).toBe(401);
    expect(await status('/v1/cards', 'apollo_not-a-token')).toBe(401);
    expect(await status('/v1/cards', device)).toBe(200);
    expect(await status('/v1/cards', producer)).toBe(403);

    expect(await status('/v1/cards', device, approval('auth:1'))).toBe(403);
    expect(await status('/v1/cards', producer, approval('auth:1'))).toBe(201);
    expect(await status('/v1/cards', connector, approval('auth:2'))).toBe(201);

    expect(await status('/v1/events', device)).toBe(403);
    expect(await status('/v1/events', producer)).toBe(200);

    expect(await status('/v1/device-tokens', producer, { name: 'x' })).toBe(403);
    expect(await status('/v1/device-tokens', device, { name: 'x' })).toBe(403);
  });

  it('guards /admin with the admin secret and never lists raw tokens', async () => {
    expect((await call('/admin/tokens', { token: 'wrong' })).status).toBe(401);
    expect((await call('/admin/tokens', { token: device })).status).toBe(401);

    const tokens = await (await call('/admin/tokens', { token: ADMIN_SECRET })).json<TokenInfo[]>();
    expect(tokens.map((t) => t.name)).toEqual(expect.arrayContaining(['phone', 'nobara', 'mini']));
    expect(Object.keys(tokens[0] ?? {}).sort()).toEqual(['createdAt', 'id', 'name', 'role']);
  });

  it('stores only token hashes', async () => {
    const stored = await runInDurableObject(inbox(), (_, state) => state.storage.sql.exec<{ hash: string }>('SELECT hash FROM tokens').toArray());
    expect(stored.map((row) => row.hash)).not.toContain(device);
    expect(stored.every((row) => /^[0-9a-f]{64}$/.test(row.hash))).toBe(true);
  });
});

describe('device tokens', () => {
  it('mints a device token for the connector, and minting again revokes the old one', async () => {
    const mint = async () => (await call('/v1/device-tokens', { token: connector, body: { name: 'device-1' } })).json<DeviceTokenResponse>();

    const first = await mint();
    expect(first.name).toBe('device-1');
    expect((await call('/v1/cards', { token: first.token })).status).toBe(200);

    const second = await mint();
    expect((await call('/v1/cards', { token: first.token })).status).toBe(401);
    expect((await call('/v1/cards', { token: second.token })).status).toBe(200);
  });

  it('revoking a device closes its socket and removes its push registration', async () => {
    const { token } = await (await call('/v1/device-tokens', { token: connector, body: { name: 'device-2' } })).json<DeviceTokenResponse>();
    const register = await call('/v1/devices', { token, body: { expoPushToken: 'ExponentPushToken[device2]', platform: 'ios' } });
    expect(register.status).toBe(204);
    const stream = await openStream(token);

    expect((await call('/v1/device-tokens/device-2', { method: 'DELETE', token: connector })).status).toBe(204);

    expect(await stream.closed).toBe(1008);
    expect((await call('/v1/cards', { token })).status).toBe(401);
    const registrations = await runInDurableObject(inbox(), (_, state) =>
      state.storage.sql.exec(`SELECT 1 FROM devices WHERE expo_push_token = 'ExponentPushToken[device2]'`).toArray(),
    );
    expect(registrations).toHaveLength(0);
  });
});

describe('rev', () => {
  it('increases on every card write and tops the snapshot', async () => {
    const seen: number[] = [];
    const card = await (await call('/v1/cards', { token: producer, body: approval('rev:1') })).json<Card>();
    seen.push(card.rev);
    seen.push((await (await call('/v1/cards', { token: producer, body: { ...approval('rev:1'), title: 'Changed' } })).json<Card>()).rev);
    seen.push((await (await call(`/v1/cards/${card.id}`, { method: 'PATCH', token: producer, body: { body: 'more' } })).json<Card>()).rev);
    seen.push((await (await call(`/v1/cards/${card.id}`, { method: 'PATCH', token: producer, body: { state: 'settled' } })).json<Card>()).rev);

    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);

    // A closed card comes back unchanged from an upsert or a second close.
    const again = await (await call('/v1/cards', { token: producer, body: approval('rev:1') })).json<Card>();
    expect(again.rev).toBe(seen.at(-1));

    const snapshot = await (await call('/v1/cards', { token: device })).json<CardSnapshot>();
    expect(snapshot.rev).toBe(Math.max(...snapshot.cards.map((c) => c.rev)));
  });
});

describe('scoped tokens', () => {
  const scope = { source: 'preview', urls: ['scryve-preview://', 'https://github.com/HashingSeeds/'] };
  const ready = (extra: Record<string, unknown> = {}) => ({ source: 'preview', key: 'scoped:1', kind: 'update', title: 'Preview ready', push: 'none', ...extra });
  let scoped: string;

  beforeAll(async () => {
    const response = await call('/admin/tokens', { token: ADMIN_SECRET, body: { role: 'producer', name: 'scryve-ci', scope } });
    scoped = (await response.json<{ token: string }>()).token;
  });

  it('writes only its source, with links under its prefixes', async () => {
    const status = async (body: unknown) => (await call('/v1/cards', { token: scoped, body })).status;

    expect(await status(ready({ url: 'scryve-preview://preview/pr-541', actions: [{ id: 'run', label: 'Run', url: 'https://github.com/HashingSeeds/scryve/actions/runs/1' }] }))).toBe(201);
    expect(await status({ ...approval('scoped:2') })).toBe(403);
    expect(await status(ready({ url: 'https://github.com/HashingSeedsEvil/x' }))).toBe(403);
    expect(await status(ready({ url: 'https://github.com/HashingSeeds/../elsewhere' }))).toBe(403);
    // Body links aren't checked: the card is plain text, so none can be opened.
    const plain = await (await call('/v1/cards', { token: scoped, body: ready({ key: 'scoped:3', body: 'See [this](javascript:alert(1)) or //evil.example' }) })).json<Card>();
    expect(plain.plainText).toBe(true);
  });

  it('keeps a card plain once a scoped token wrote it', async () => {
    const byMini = await (await call('/v1/cards', { token: producer, body: ready({ key: 'scoped:5', body: '[run](https://example.test)' }) })).json<Card>();
    expect(byMini.plainText).toBeUndefined();
    const patched = await (await call(`/v1/cards/${byMini.id}`, { method: 'PATCH', token: scoped, body: { body: 'Publishing' } })).json<Card>();
    expect(patched.plainText).toBe(true);
    const again = await (await call('/v1/cards', { token: producer, body: ready({ key: 'scoped:5', body: 'Ready' }) })).json<Card>();
    expect(again.plainText).toBe(true);
  });

  it('cannot patch or read another source', async () => {
    const other = await (await call('/v1/cards', { token: producer, body: approval('scoped:hermes') })).json<Card>();
    expect((await call(`/v1/cards/${other.id}`, { method: 'PATCH', token: scoped, body: { state: 'settled' } })).status).toBe(403);
    expect((await call('/v1/events?source=hermes', { token: scoped })).status).toBe(403);
    expect((await call('/v1/events', { token: scoped })).status).toBe(200);
  });

  it('is only for producers, and the admin list shows it', async () => {
    expect((await call('/admin/tokens', { token: ADMIN_SECRET, body: { role: 'device', name: 'x', scope } })).status).toBe(400);
    expect((await call('/admin/tokens', { token: ADMIN_SECRET, body: { role: 'producer', name: 'x', scope: { ...scope, urls: ['https://github.com'] } } })).status).toBe(400);
    const tokens = await (await call('/admin/tokens', { token: ADMIN_SECRET })).json<TokenInfo[]>();
    expect(tokens.find((t) => t.name === 'scryve-ci')?.scope).toEqual(scope);
  });

  it('takes new link prefixes in place, keeping its source', async () => {
    const created = await (await call('/admin/tokens', { token: ADMIN_SECRET, body: { role: 'producer', name: 'scryve-feedback', scope: { source: 'feedback', urls: [] } } })).json<{ id: string; token: string }>();
    const links = (urls: unknown, id = created.id) => call(`/admin/tokens/${id}/links`, { method: 'PUT', token: ADMIN_SECRET, body: { urls } });
    const sentry = { source: 'feedback', key: 'links:1', kind: 'update', title: 'Bug', push: 'none', actions: [{ id: 'sentry', label: 'Sentry', url: 'https://sentry.test/issues/?query=1' }] };
    expect((await call('/v1/cards', { token: created.token, body: sentry })).status).toBe(403);

    const updated = await links(['https://sentry.test/']);
    expect(await updated.json<TokenInfo>()).toMatchObject({ id: created.id, scope: { source: 'feedback', urls: ['https://sentry.test/'] } });
    expect((await call('/v1/cards', { token: created.token, body: sentry })).status).toBe(201);

    expect((await links(['https://sentry.test'])).status).toBe(400);
    expect((await call(`/admin/tokens/${created.id}/links`, { method: 'PUT', token: created.token, body: { urls: [] } })).status).toBe(401);
    const unscoped = (await (await call('/admin/tokens', { token: ADMIN_SECRET })).json<TokenInfo[]>()).find((t) => !t.scope && t.role === 'producer');
    expect((await links([], unscoped?.id)).status).toBe(400);
    expect((await links([], 'missing')).status).toBe(404);
  });
});
