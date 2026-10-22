// A card that moves through phases in place: approve, publish, ready.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CardInput, InboxEvent } from '../src/contract';
import { call, createToken, mockExpo, openStream, postCard, respond, sentPushes } from './helpers';

let device: string;
let producer: string;

beforeAll(async () => {
  device = await createToken('device', 'phone');
  producer = await createToken('producer', 'mini');
  await call('/v1/devices', { token: device, body: { expoPushToken: 'ExponentPushToken[phone]', platform: 'ios' } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const waiting = (key: string): CardInput => ({
  source: 'preview',
  key,
  kind: 'approval',
  title: 'Scryve #541 preview',
  phase: 'waiting',
  keepOpen: true,
  actions: [
    { id: 'approve', label: 'Approve', style: 'primary' },
    { id: 'reject', label: 'Reject', style: 'destructive' },
  ],
});

describe('keepOpen', () => {
  it('records the first action but leaves the card open for its producer', async () => {
    mockExpo();
    const card = await postCard(producer, waiting('preview:541:2c0f987:1'));

    const approved = await (await respond(device, card.id, { actionId: 'approve' })).json();
    expect(approved).toMatchObject({ id: card.id, state: 'open', resolution: { actionId: 'approve', by: 'phone' } });
    // A second answer changes nothing and logs nothing.
    expect(await (await respond(device, card.id, { actionId: 'reject' })).json()).toEqual(approved);
    const events = await (await call('/v1/events?source=preview', { token: producer })).json<InboxEvent[]>();
    expect(events.filter((e) => e.cardId === card.id)).toHaveLength(1);

    const publishing = await postCard(producer, { source: 'preview', key: card.key, kind: 'update', title: card.title, phase: 'publishing', push: 'none', progress: { label: 'Fingerprint', step: 3, of: 7 } });
    expect(publishing).toMatchObject({ id: card.id, state: 'open', kind: 'update', progress: { label: 'Fingerprint', step: 3, of: 7 }, resolution: { actionId: 'approve' } });
  });

  it('rejects progress past its end', async () => {
    const response = await call('/v1/cards', { token: producer, body: { ...waiting('preview:bad'), progress: { label: 'x', step: 8, of: 7 } } });
    expect(response.status).toBe(400);
  });
});

describe('phase', () => {
  it('pushes again only when the phase changes, at the level it sends', async () => {
    const expo = mockExpo();
    const key = 'preview:600:aaaaaaa:1';
    const card = await postCard(producer, waiting(key));
    await vi.waitFor(() => expect(expo).toHaveBeenCalledTimes(1));

    await postCard(producer, { ...waiting(key), title: 'Same phase, new title' });
    const publishing = await postCard(producer, { source: 'preview', key, kind: 'update', title: 'Publishing', phase: 'publishing', push: 'none' });
    expect(publishing.push).toBe('none');
    const ready = await postCard(producer, { source: 'preview', key, kind: 'update', title: 'Preview ready', phase: 'ready', push: 'passive' });
    await vi.waitFor(() => expect(expo).toHaveBeenCalledTimes(2));

    expect(ready.push).toBe('passive');
    expect(sentPushes(expo).map(([push]) => [push?.data.cardId, push?.interruptionLevel])).toEqual([[card.id, 'active'], [card.id, 'passive']]);
  });
});

describe('replaces', () => {
  it('settles the earlier card and links the two both ways', async () => {
    mockExpo();
    const stream = await openStream(device);
    const first = await postCard(producer, waiting('preview:700:bbbbbbb:1'));
    const rerun = await postCard(producer, { ...waiting('preview:700:bbbbbbb:2'), title: 'Scryve #541 preview, attempt 2', replaces: first.key });

    expect(rerun.replaces).toEqual({ id: first.id, title: first.title });
    await vi.waitFor(() => expect(stream.messages).toContainEqual({
      type: 'card',
      card: expect.objectContaining({ id: first.id, state: 'settled', replacedBy: { id: rerun.id, title: rerun.title } }),
    }));

    // Re-upserting the rerun keeps its link even without `replaces`.
    expect((await postCard(producer, waiting('preview:700:bbbbbbb:2'))).replaces).toEqual(rerun.replaces);
  });

  it('ignores a key with no card', async () => {
    mockExpo();
    const card = await postCard(producer, { ...waiting('preview:701:ccccccc:1'), replaces: 'preview:701:nothing:1' });
    expect(card).not.toHaveProperty('replaces');
  });
});
