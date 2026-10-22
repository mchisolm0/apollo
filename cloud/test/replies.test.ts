// Actions that can be used again and again, and actions that carry text: replying to feedback.
import { beforeAll, describe, expect, it } from 'vitest';

import type { Card, CardInput, InboxEvent } from '../src/contract';
import { ADMIN_SECRET, call, createToken, postCard, respond } from './helpers';

let device: string;
let producer: string;

beforeAll(async () => {
  device = await createToken('device', 'phone');
  const response = await call('/admin/tokens', { token: ADMIN_SECRET, body: { role: 'producer', name: 'scryve-feedback', scope: { source: 'feedback', urls: [] } } });
  producer = (await response.json<{ token: string }>()).token;
});

const request = (key: string): CardInput => ({
  source: 'feedback',
  key,
  kind: 'approval',
  title: 'Sync sessions across devices',
  body: 'Started a focus session on my phone and wanted it on the tablet.',
  keepOpen: true,
  actions: [
    { id: 'reply', label: 'Reply', style: 'primary', input: 'text', repeat: true },
    { id: 'publish', label: 'Publish' },
    { id: 'decline', label: 'Decline', style: 'destructive' },
  ],
});

const eventsFor = async (card: Card) =>
  (await (await call('/v1/events?source=feedback', { token: producer })).json<InboxEvent[]>()).filter((event) => event.cardId === card.id);

describe('repeat actions', () => {
  it('record an event each time and leave the card open with no resolution', async () => {
    const card = await postCard(producer, request('request:1'));

    for (const text of ['Thanks! Which tablet?', 'Shipped in 2.1.0.']) {
      const response = await respond(device, card.id, { actionId: 'reply', text });
      expect(response.status).toBe(200);
      const after = await response.json<Card>();
      expect(after.state).toBe('open');
      expect(after.resolution).toBeUndefined();
      expect(after.rev).toBe(card.rev);
    }

    const events = await eventsFor(card);
    expect(events.map((event) => event.type === 'action' && event.text)).toEqual(['Thanks! Which tablet?', 'Shipped in 2.1.0.']);
  });

  it('still work after the first answer, and a non-repeat action still answers once', async () => {
    const card = await postCard(producer, request('request:2'));
    expect(await (await respond(device, card.id, { actionId: 'publish' })).json()).toMatchObject({ state: 'open', resolution: { actionId: 'publish' } });
    expect((await respond(device, card.id, { actionId: 'reply', text: 'Live on the board now.' })).status).toBe(200);
    expect((await eventsFor(card)).map((event) => event.type === 'action' && event.actionId)).toEqual(['publish', 'reply']);
  });

  it('get 409 once the card is closed', async () => {
    const card = await postCard(producer, request('request:3'));
    await call(`/v1/cards/${card.id}`, { method: 'PATCH', token: producer, body: { state: 'resolved' } });
    expect((await respond(device, card.id, { actionId: 'reply', text: 'Too late' })).status).toBe(409);
  });
});

describe('text', () => {
  it('is required by an input action and refused by any other', async () => {
    const card = await postCard(producer, request('request:4'));
    const missing = await respond(device, card.id, { actionId: 'reply' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: 'bad_text' } });
    expect((await respond(device, card.id, { actionId: 'decline', text: 'No' })).status).toBe(400);
    expect((await respond(device, card.id, { actionId: 'reply', text: '' })).status).toBe(400);
    expect((await respond(device, card.id, { actionId: 'reply', text: 'x'.repeat(4001) })).status).toBe(400);
    expect(await eventsFor(card)).toEqual([]);
  });

  it('is part of the idempotency body', async () => {
    const card = await postCard(producer, request('request:5'));
    const key = crypto.randomUUID();
    expect((await respond(device, card.id, { actionId: 'reply', text: 'One' }, key)).status).toBe(200);
    expect((await respond(device, card.id, { actionId: 'reply', text: 'One' }, key)).status).toBe(200);
    expect((await respond(device, card.id, { actionId: 'reply', text: 'Two' }, key)).status).toBe(422);
    expect(await eventsFor(card)).toHaveLength(1);
  });

  it('cannot come with a url action', async () => {
    const response = await call('/v1/cards', { token: producer, body: { ...request('request:6'), actions: [{ id: 'open', label: 'Open', url: 'https://example.com/', input: 'text' }] } });
    expect(response.status).toBe(400);
  });
});
