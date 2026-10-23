// Store reviews: cards from both stores, and replies posted back to them.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CardSnapshot } from '../src/contract';
import { sha256Hex } from '../src/crypto';
import { pullReviews, reviewCard, sendReviewReplies, type ReviewsConfig } from '../src/reviews';
import { signJwt } from '../src/stores/jwt';
import type { StoreReview } from '../src/stores/review';
import { ADMIN_SECRET, call, createToken, inbox, respond } from './helpers';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW - ms).toISOString();

async function pem(key: CryptoKey) {
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', key)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
}

let config: ReviewsConfig;
let device: string;
let appleKey: CryptoKeyPair;

beforeAll(async () => {
  appleKey = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const googleKey = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const created = await call('/admin/tokens', { token: ADMIN_SECRET, body: { role: 'producer', name: 'store-reviews', scope: { source: 'reviews', urls: [] } } });
  const { token } = await created.json<{ token: string }>();
  device = await createToken('device', 'phone');
  config = {
    apps: [{ name: 'Scryve', appStore: '111', play: 'com.example.app' }],
    appStore: { issuerId: 'issuer', keyId: 'KEY123', privateKey: await pem(appleKey.privateKey) },
    play: { client_email: 'bot@example.iam.gserviceaccount.com', private_key: await pem(googleKey.privateKey) },
    tokenHash: await sha256Hex(token),
  };
});

afterEach(() => vi.restoreAllMocks());

type Route = (url: URL, init?: RequestInit) => Response | undefined;
function stores(...routes: Route[]) {
  vi.restoreAllMocks();
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'google-token', expires_in: 3600 });
    for (const route of routes) {
      const response = route(url, init);
      if (response) return response;
    }
    return new Response('not mocked', { status: 599 });
  });
}

const appleList = (url: URL) =>
  url.pathname === '/v1/apps/111/customerReviews'
    ? Response.json({
        data: [
          { id: 'a1', type: 'customerReviews', attributes: { rating: 2, title: 'Timer resets', body: 'When I rotate.', reviewerNickname: 'ana', createdDate: at(HOUR), territory: 'USA' }, relationships: { response: { data: null } } },
          { id: 'a2', type: 'customerReviews', attributes: { rating: 5, title: 'Love it', body: 'Great.', createdDate: at(5 * 24 * HOUR), territory: 'GBR' }, relationships: { response: { data: { id: 'r2', type: 'customerReviewResponses' } } } },
          { id: 'a3', type: 'customerReviews', attributes: { rating: 1, title: 'Old', body: 'Ancient.', createdDate: at(40 * 24 * HOUR) } },
        ],
        included: [{ id: 'r2', type: 'customerReviewResponses', attributes: { responseBody: 'Thanks!', state: 'PENDING_PUBLISH' } }],
      })
    : undefined;

const seconds = (ms: number) => String(Math.floor((NOW - ms) / 1000));
const playReview = (id: string, extra: object = {}) => ({
  reviewId: id,
  authorName: 'Bo',
  comments: [
    { userComment: { text: 'Gran app\tFalta el modo oscuro', originalText: 'Gran app\tFalta el modo oscuro', starRating: 3, reviewerLanguage: 'es', appVersionName: '2.1.0', lastModified: { seconds: seconds(HOUR) }, deviceMetadata: { manufacturer: 'Google', productName: 'Pixel 9a' }, ...extra } },
  ],
});
const playList = (url: URL) =>
  url.pathname === '/androidpublisher/v3/applications/com.example.app/reviews'
    ? Response.json({ reviews: [playReview('p1', { text: 'Great app\tNeeds dark mode' })] })
    : undefined;

const cards = async () => (await (await call('/v1/cards', { token: device })).json<CardSnapshot>()).cards.filter((card) => card.source === 'reviews');
const byKey = async (key: string) => (await cards()).find((card) => card.key === key)!;

describe('store reviews', () => {
  it('signs ES256 tokens Apple can verify', async () => {
    const jwt = await signJwt('ES256', config.appStore!.privateKey, { kid: 'KEY123' }, { aud: 'appstoreconnect-v1' });
    const [header, payload, signature] = jwt.split('.');
    const bytes = (part: string) => Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(bytes(header!)))).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'KEY123' });
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, appleKey.publicKey, bytes(signature!), new TextEncoder().encode(`${header}.${payload}`));
    expect(valid).toBe(true);
  });

  it('turns recent reviews from both stores into cards, skipping old ones', async () => {
    const fetch = stores(appleList, playList);
    await pullReviews(inbox(), config, NOW);

    const apple = await byKey('appstore:111:a1');
    expect(apple).toMatchObject({ kind: 'approval', title: '★★☆☆☆ Scryve: Timer resets', body: 'When I rotate.', push: 'alert', plainText: true, meta: { store: 'App Store', from: 'USA', by: 'ana' } });
    expect(apple.actions).toEqual([{ id: 'reply', label: 'Reply', style: 'primary', input: 'text', repeat: true }]);

    expect(await byKey('appstore:111:a2')).toMatchObject({ kind: 'update', push: 'none', body: 'Great.\n\nYour reply, waiting on Apple: Thanks!' });
    expect((await cards()).some((card) => card.key === 'appstore:111:a3')).toBe(false);

    expect(await byKey('play:com.example.app:p1')).toMatchObject({
      kind: 'approval',
      title: '★★★☆☆ Scryve: Great app',
      body: 'Needs dark mode\n\nOriginal: Gran app\nFalta el modo oscuro',
      meta: { store: 'Google Play', version: '2.1.0', device: 'Google Pixel 9a', from: 'es' },
    });
    const playCall = fetch.mock.calls.find(([input]) => String(input).includes('/reviews?'));
    expect(new URL(String(playCall![0])).searchParams.get('translationLanguage')).toBe('en');
  });

  it('posts a reply typed on the card and shows it once the store has it', async () => {
    let replied: unknown;
    stores(
      (url, init) => (url.pathname === '/v1/customerReviewResponses' && init?.method === 'POST' ? ((replied = JSON.parse(String(init.body))), Response.json({}, { status: 201 })) : undefined),
      (url) =>
        url.pathname === '/v1/customerReviews/a1'
          ? Response.json({
              data: { id: 'a1', type: 'customerReviews', attributes: { rating: 2, title: 'Timer resets', body: 'When I rotate.', createdDate: at(HOUR) }, relationships: { response: { data: { id: 'r1', type: 'customerReviewResponses' } } } },
              included: [{ id: 'r1', type: 'customerReviewResponses', attributes: { responseBody: 'Fixed in 2.2.', state: 'PENDING_PUBLISH' } }],
            })
          : undefined,
    );
    const card = await byKey('appstore:111:a1');
    expect((await respond(device, card.id, { actionId: 'reply', text: 'Fixed in 2.2.' })).status).toBe(200);
    await sendReviewReplies(inbox(), config, NOW);

    expect(replied).toEqual({ data: { type: 'customerReviewResponses', attributes: { responseBody: 'Fixed in 2.2.' }, relationships: { review: { data: { type: 'customerReviews', id: 'a1' } } } } });
    expect(await byKey('appstore:111:a1')).toMatchObject({ kind: 'update', state: 'open', body: 'When I rotate.\n\nYour reply, waiting on Apple: Fixed in 2.2.', actions: [{ label: 'Edit reply', prefill: 'Fixed in 2.2.' }] });
  });

  it('retries a reply after a store outage, and shows a refusal on the card', async () => {
    const card = await byKey('play:com.example.app:p1');
    await respond(device, card.id, { actionId: 'reply', text: 'Dark mode is coming.' });

    const down = stores((url) => (url.pathname.endsWith(':reply') ? new Response('busy', { status: 503 }) : undefined));
    await sendReviewReplies(inbox(), config, NOW);
    expect(down.mock.calls.filter(([input]) => String(input).endsWith(':reply'))).toHaveLength(1);

    let body: unknown;
    stores(
      (url, init) => (url.pathname.endsWith('/reviews/p1:reply') ? ((body = JSON.parse(String(init?.body))), Response.json({ result: {} })) : undefined),
      (url) => (url.pathname.endsWith('/reviews/p1') ? Response.json({ ...playReview('p1', { text: 'Great app\tNeeds dark mode' }), comments: [playReview('p1').comments[0], { developerComment: { text: 'Dark mode is coming.', lastModified: { seconds: seconds(0) } } }] }) : undefined),
    );
    await sendReviewReplies(inbox(), config, NOW);
    expect(body).toEqual({ replyText: 'Dark mode is coming.' });
    expect(await byKey('play:com.example.app:p1')).toMatchObject({ kind: 'update' });

    const posts = stores((url) => (url.pathname.endsWith('/reviews/p1') ? Response.json(playReview('p1')) : undefined));
    await respond(device, card.id, { actionId: 'reply', text: 'x'.repeat(351) });
    await sendReviewReplies(inbox(), config, NOW);
    expect(posts.mock.calls.some(([input]) => String(input).endsWith(':reply'))).toBe(false);
    expect((await byKey('play:com.example.app:p1')).meta?.problem).toBe('Not sent: Google Play replies are at most 350 characters.');
  });

  it("pushes an edited review again, but not a reply or an old review's first sighting", () => {
    const review: StoreReview = { store: 'play', appId: 'pkg', id: 'x', rating: 4, text: 'ok', updatedAt: at(HOUR) };
    expect(reviewCard(review, 'Scryve', NOW)).toMatchObject({ phase: `review:${at(HOUR)}`, push: 'passive' });
    expect(reviewCard({ ...review, reply: { text: 'thanks' } }, 'Scryve', NOW).phase).toBe(`review:${at(HOUR)}`);
    expect(reviewCard({ ...review, updatedAt: at(3 * 24 * HOUR) }, 'Scryve', NOW).push).toBe('none');
  });
});

