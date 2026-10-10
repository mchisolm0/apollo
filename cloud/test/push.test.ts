import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import type { DeviceTokenResponse } from '../src/contract';
import { approval, call, createToken, inbox, mockExpo, postCard, sentPushes } from './helpers';

let producer: string;
let connector: string;

beforeAll(async () => {
  producer = await createToken('producer', 'mini');
  connector = await createToken('connector', 'mini');
  for (const name of ['a', 'b']) {
    const device = await createToken('device', name);
    await call('/v1/devices', { token: device, body: { expoPushToken: `ExponentPushToken[${name}]`, platform: 'ios' } });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ok = { status: 'ok', id: 't' };
const rateLimited = { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } };
const recipientsOf = (expo: ReturnType<typeof mockExpo>) => sentPushes(expo).map((messages) => messages.map((m) => m.to));

/** Makes a card's next retry due now instead of in 30 seconds, then runs the alarm. */
async function retryNow(cardId: string) {
  await runInDurableObject(inbox(), (_, state) => state.storage.sql.exec('UPDATE cards SET push_next_at = 0 WHERE id = ?', cardId));
  await runDurableObjectAlarm(inbox());
}

const pushState = (id: string) =>
  runInDurableObject(inbox(), (_, state) =>
    state.storage.sql.exec<{ push_status: string; push_attempts: number }>('SELECT push_status, push_attempts FROM cards WHERE id = ?', id).one(),
  );

it('retries a failed Expo send from the alarm', async () => {
  const expo = mockExpo(() => new Response('unavailable', { status: 503 }));
  const card = await postCard(producer, approval('retry:1'));
  await vi.waitFor(async () => expect(await pushState(card.id)).toEqual({ push_status: 'pending', push_attempts: 1 }));

  await retryNow(card.id);

  expect(expo).toHaveBeenCalledTimes(2);
  expect(await pushState(card.id)).toEqual({ push_status: 'sent', push_attempts: 1 });
});

it('retries only the recipients whose Expo ticket failed', async () => {
  const expo = mockExpo((tokens) => Response.json({ data: tokens.map((t) => (t === 'ExponentPushToken[b]' ? rateLimited : ok)) }));
  const card = await postCard(producer, approval('tickets:1'));
  await vi.waitFor(async () => expect(await pushState(card.id)).toEqual({ push_status: 'pending', push_attempts: 1 }));

  await retryNow(card.id);

  expect(recipientsOf(expo)).toEqual([['ExponentPushToken[a]', 'ExponentPushToken[b]'], ['ExponentPushToken[b]']]);
  expect((await pushState(card.id)).push_status).toBe('sent');
});

it('stops pushing to a phone Expo reports as DeviceNotRegistered', async () => {
  mockExpo((tokens) =>
    Response.json({
      data: tokens.map((token) =>
        token === 'ExponentPushToken[b]' ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 't' },
      ),
    }),
  );
  const card = await postCard(producer, approval('prune:1'));
  await vi.waitFor(async () => expect((await pushState(card.id)).push_status).toBe('sent'));

  const devices = await runInDurableObject(inbox(), (_, state) =>
    state.storage.sql.exec<{ expo_push_token: string }>('SELECT expo_push_token FROM devices').toArray(),
  );
  expect(devices.map((d) => d.expo_push_token)).toEqual(['ExponentPushToken[a]']);
});

it('never retries to a token revoked after the first send, even if the phone registers again', async () => {
  const mint = async () => (await call('/v1/device-tokens', { token: connector, body: { name: 'c' } })).json<DeviceTokenResponse>();
  const register = (token: string) => call('/v1/devices', { token, body: { expoPushToken: 'ExponentPushToken[c]', platform: 'ios' } });
  await register((await mint()).token);

  const expo = mockExpo(() => new Response('unavailable', { status: 503 }));
  const card = await postCard(producer, approval('revoked:1'));
  await vi.waitFor(async () => expect((await pushState(card.id)).push_attempts).toBe(1));

  expect((await call('/v1/device-tokens/c', { method: 'DELETE', token: connector })).status).toBe(204);
  await register((await mint()).token);
  await retryNow(card.id);

  expect(recipientsOf(expo)).toEqual([['ExponentPushToken[a]', 'ExponentPushToken[c]'], ['ExponentPushToken[a]']]);
});
