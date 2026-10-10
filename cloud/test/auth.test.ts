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
