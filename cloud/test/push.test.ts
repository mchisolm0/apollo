import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import { approval, call, createToken, inbox, mockExpo, postCard } from './helpers';

let producer: string;

beforeAll(async () => {
  producer = await createToken('producer', 'mini');
  for (const name of ['a', 'b']) {
    const device = await createToken('device', name);
    await call('/v1/devices', { token: device, body: { expoPushToken: `ExponentPushToken[${name}]`, platform: 'ios' } });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const pushState = (id: string) =>
  runInDurableObject(inbox(), (_, state) =>
    state.storage.sql.exec<{ push_status: string; push_attempts: number }>('SELECT push_status, push_attempts FROM cards WHERE id = ?', id).one(),
  );

it('retries a failed Expo send from the alarm', async () => {
  const expo = mockExpo(() => new Response('unavailable', { status: 503 }));
  const card = await postCard(producer, approval('retry:1'));
  await vi.waitFor(async () => expect(await pushState(card.id)).toEqual({ push_status: 'pending', push_attempts: 1 }));

  // Make the retry due now instead of in 30 seconds.
  await runInDurableObject(inbox(), (_, state) => state.storage.sql.exec('UPDATE cards SET push_next_at = 0 WHERE id = ?', card.id));
  await runDurableObjectAlarm(inbox());

  expect(expo).toHaveBeenCalledTimes(2);
  expect(await pushState(card.id)).toEqual({ push_status: 'sent', push_attempts: 1 });
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
