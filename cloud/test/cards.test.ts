import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ApiError, Card, CardInput, CardSnapshot, InboxEvent } from '../src/contract';
import { approval, call, createToken, inbox, mockExpo, openStream, postCard, respond, sentPushes } from './helpers';

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

const briefing = (picks: CardInput['picks']): CardInput => ({ source: 'morning', key: '2026-10-09', kind: 'briefing', title: 'Morning', picks });

describe('upsert', () => {
  it('upserts by (source, key) and pushes only the first time', async () => {
    const expo = mockExpo();
    const first = await postCard(producer, approval('run:1:req:1'));
    await vi.waitFor(() => expect(expo).toHaveBeenCalledTimes(1));

    const second = await postCard(producer, { ...approval('run:1:req:1'), title: 'Run rm -rf dist?' });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Run rm -rf dist?');

    expect(sentPushes(expo)[0]?.[0]).toMatchObject({
      to: 'ExponentPushToken[phone]',
      data: { cardId: first.id, source: 'hermes', kind: 'approval' },
      threadId: 'hermes',
      categoryId: 'apollo.approval',
      interruptionLevel: 'active',
      channelId: 'alerts',
    });
    expect(expo).toHaveBeenCalledTimes(1);
  });

  it('sends updates as passive pushes', async () => {
    const expo = mockExpo();
    await postCard(producer, { source: 'preview', key: 'pr:9', kind: 'update', title: 'Preview ready' });
    await vi.waitFor(() => expect(expo).toHaveBeenCalledTimes(1));
    const push = sentPushes(expo)[0]?.[0];
    expect(push).toMatchObject({ interruptionLevel: 'passive', channelId: 'updates', sound: null });
    expect(push).not.toHaveProperty('categoryId');
  });

  it('keeps done on a re-upserted pick with the same n and text', async () => {
    mockExpo();
    const card = await postCard(producer, briefing([{ n: 1, text: 'Ship #335', done: false }, { n: 2, text: 'Reply to Theo', done: false }]));
    await respond(device, card.id, { pick: 1, done: true });

    const updated = await postCard(producer, briefing([{ n: 1, text: 'Ship #335', done: false }, { n: 2, text: 'Reply to Zed', done: false }]));
    expect(updated.picks).toEqual([
      { n: 1, text: 'Ship #335', done: true },
      { n: 2, text: 'Reply to Zed', done: false },
    ]);
  });

  it('rejects picks on non-briefing cards', async () => {
    const response = await call('/v1/cards', { token: producer, body: { ...approval('bad'), picks: [{ n: 1, text: 'x', done: false }] } });
    expect(response.status).toBe(400);
  });
});

describe('respond', () => {
  it('resolves the card, appends one event, and streams the change', async () => {
    mockExpo();
    const stream = await openStream(device);
    const card = await postCard(producer, approval('run:2:req:1'));
    await vi.waitFor(() => expect(stream.messages).toContainEqual({ type: 'card', card }));

    const response = await respond(device, card.id, { actionId: 'approve' });
    const resolved = await response.json<Card>();
    expect(resolved).toMatchObject({ state: 'resolved', resolution: { actionId: 'approve', by: 'phone' } });

    const events = await (await call('/v1/events?source=hermes', { token: producer })).json<InboxEvent[]>();
    expect(events.filter((e) => e.cardId === card.id)).toEqual([
      expect.objectContaining({ type: 'action', actionId: 'approve', key: 'run:2:req:1', by: 'phone' }),
    ]);
    stream.ws.close();
  });

  it('lets the first action win and answers later ones with 409 card_closed', async () => {
    mockExpo();
    const card = await postCard(producer, approval('run:3:req:1'));
    const [a, b] = await Promise.all([respond(device, card.id, { actionId: 'approve' }), respond(device, card.id, { actionId: 'reject' })]);
    expect([a.status, b.status]).toEqual([200, 409]);
    const conflict = await b.json<ApiError>();
    expect(conflict.error.code).toBe('card_closed');
    expect(conflict.error.card).toMatchObject({ id: card.id, state: 'resolved', resolution: { actionId: 'approve' } });
  });

  it('replays an Idempotency-Key without a second event, and rejects it with a different body', async () => {
    mockExpo();
    const card = await postCard(producer, approval('run:4:req:1'));
    const first = await (await respond(device, card.id, { actionId: 'approve' }, 'key-1')).json<Card>();
    const replay = await respond(device, card.id, { actionId: 'approve' }, 'key-1');
    expect(replay.status).toBe(200);
    expect(await replay.json<Card>()).toEqual(first);

    expect((await respond(device, card.id, { actionId: 'reject' }, 'key-1')).status).toBe(422);
    expect((await call(`/v1/cards/${card.id}/respond`, { token: device, body: { actionId: 'approve' } })).status).toBe(400);

    const events = await (await call('/v1/events', { token: producer })).json<InboxEvent[]>();
    expect(events.filter((e) => e.cardId === card.id)).toHaveLength(1);
  });

  it('schedules the alarm so a resolved card reaches retention', async () => {
    const card = await postCard(producer, { ...approval('run:6:req:1'), push: 'none' });
    await runInDurableObject(inbox(), (_, state) => state.storage.deleteAlarm());
    expect((await respond(device, card.id, { actionId: 'approve' })).status).toBe(200);
    expect(await runInDurableObject(inbox(), (_, state) => state.storage.getAlarm())).not.toBeNull();
  });

  it('rejects a body that mixes an action and a pick', async () => {
    mockExpo();
    const card = await postCard(producer, approval('run:5:req:1'));
    expect((await respond(device, card.id, { actionId: 'approve', pick: 1, done: true })).status).toBe(400);
  });
});

describe('briefing actions', () => {
  const morning = (key: string): CardInput => ({
    ...briefing([{ n: 1, text: 'Ship #335', done: false }]),
    key,
    actions: [{ id: 'keep', label: 'Keep' }],
  });

  it('records Keep without closing the card, so picks still work', async () => {
    mockExpo();
    const card = await postCard(producer, morning('2026-10-10'));

    const kept = await respond(device, card.id, { actionId: 'keep' });
    expect(kept.status).toBe(200);
    expect(await kept.json<Card>()).toMatchObject({ state: 'open' });

    const picked = await respond(device, card.id, { pick: 1, done: true });
    expect(picked.status).toBe(200);
    expect((await picked.json<Card>()).picks?.[0]?.done).toBe(true);
  });

  it('records each action once per briefing', async () => {
    mockExpo();
    const card = await postCard(producer, morning('2026-10-11'));
    await respond(device, card.id, { actionId: 'keep' });
    const repeat = await respond(device, card.id, { actionId: 'keep' });
    expect(repeat.status).toBe(200);
    expect((await repeat.json<Card>()).rev).toBe(card.rev);

    const events = await (await call('/v1/events?source=morning', { token: producer })).json<InboxEvent[]>();
    expect(events.filter((e) => e.cardId === card.id && e.type === 'action')).toHaveLength(1);
  });
});

describe('events', () => {
  it('pages oldest first from a cursor and filters by source', async () => {
    mockExpo();
    const morning = await postCard(producer, briefing([{ n: 1, text: 'One', done: false }]));
    await respond(device, morning.id, { pick: 1, done: true });
    await respond(device, morning.id, { pick: 1, done: false });

    const all = await (await call('/v1/events', { token: producer })).json<InboxEvent[]>();
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const last = all.at(-2)?.seq ?? 0;
    const after = await (await call(`/v1/events?after=${last}`, { token: producer })).json<InboxEvent[]>();
    expect(after).toEqual([expect.objectContaining({ type: 'pick', pick: 1, done: false })]);

    const morningOnly = await (await call('/v1/events?source=morning', { token: producer })).json<InboxEvent[]>();
    expect(morningOnly.every((e) => e.source === 'morning')).toBe(true);
  });
});

describe('alarm', () => {
  it('settles a card once it expires', async () => {
    mockExpo();
    const card = await postCard(producer, { source: 'jobs', key: 'job:1', kind: 'update', title: 'Stale', push: 'none', expiresAt: new Date(Date.now() - 1000).toISOString() });
    await runDurableObjectAlarm(inbox());
    await vi.waitFor(async () => {
      const { cards } = await (await call('/v1/cards', { token: device })).json<CardSnapshot>();
      expect(cards.find((c) => c.id === card.id)?.state).toBe('settled');
    });
  });
});
