// Store reviews as cards. A cron pulls new App Store and Google Play reviews
// into the inbox, and a reply typed on a card is posted back to the store.
// It writes through the normal producer path with a token scoped to `reviews`.

import type { CardInput, InboxEvent } from './contract';
import { sha256Hex } from './crypto';
import type { Inbox } from './inbox';
import { getAppStoreReview, listAppStoreReviews, replyOnAppStore, type AppStoreKey } from './stores/appStore';
import { getPlayReview, listPlayReviews, replyOnPlay, type ServiceAccount } from './stores/googlePlay';
import { REPLY_LIMIT, StoreError, type Store, type StoreApp, type StoreReview } from './stores/review';

const DAY = 24 * 60 * 60 * 1000;
/** Older reviews stay out of the inbox; their cards settle at the same age. */
const KEEP_FOR = 30 * DAY;
/** A review this old when first seen, like the backlog on the first run, arrives without a push. */
const PUSH_WITHIN = 2 * DAY;
const CURSOR = 'reviews.events';
const STORE_NAMES: Record<Store, string> = { appstore: 'App Store', play: 'Google Play' };

export interface ReviewsConfig {
  apps: StoreApp[];
  appStore?: AppStoreKey;
  play?: ServiceAccount;
  /** SHA-256 of the producer token scoped to `reviews`. */
  tokenHash: string;
}

export async function reviewsConfig(env: Env): Promise<ReviewsConfig | undefined> {
  if (!env.REVIEWS_TOKEN || !env.REVIEW_APPS) return undefined;
  const appStore = env.ASC_ISSUER_ID && env.ASC_KEY_ID && env.ASC_PRIVATE_KEY
    ? { issuerId: env.ASC_ISSUER_ID, keyId: env.ASC_KEY_ID, privateKey: env.ASC_PRIVATE_KEY }
    : undefined;
  const play = env.GOOGLE_SERVICE_ACCOUNT ? (JSON.parse(env.GOOGLE_SERVICE_ACCOUNT) as ServiceAccount) : undefined;
  return {
    apps: JSON.parse(env.REVIEW_APPS) as StoreApp[],
    ...(appStore ? { appStore } : {}),
    ...(play ? { play } : {}),
    tokenHash: await sha256Hex(env.REVIEWS_TOKEN),
  };
}

const stars = (rating: number) => '★'.repeat(rating) + '☆'.repeat(Math.max(0, 5 - rating));
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const reviewKey = (review: Pick<StoreReview, 'store' | 'appId' | 'id'>) => `${review.store}:${review.appId}:${review.id}`;

function parseKey(key: string) {
  const [store, appId, ...id] = key.split(':');
  return (store === 'appstore' || store === 'play') && appId && id.length ? { store, appId, id: id.join(':') } as const : undefined;
}

export function reviewCard(review: StoreReview, appName: string, now = Date.now(), problem?: string): CardInput {
  const age = now - Date.parse(review.updatedAt);
  const headline = review.title ?? review.text.split('\n')[0] ?? '';
  const body = [
    review.title ? review.text : review.text.split('\n').slice(1).join('\n').trim(),
    review.originalText ? `Original: ${review.originalText}` : '',
    review.reply ? `Your reply${review.reply.pending ? ', waiting on Apple' : ''}: ${review.reply.text}` : '',
  ].filter(Boolean).join('\n\n');
  return {
    source: 'reviews',
    key: reviewKey(review),
    kind: review.reply ? 'update' : 'approval',
    title: clip(`${stars(review.rating)} ${appName}: ${headline || 'No text'}`, 200),
    ...(body ? { body: clip(body, 4000) } : {}),
    meta: {
      store: STORE_NAMES[review.store],
      ...(review.appVersion ? { version: review.appVersion } : {}),
      ...(review.device ? { device: clip(review.device, 200) } : {}),
      ...(review.locale ? { from: review.locale } : {}),
      ...(review.author ? { by: clip(review.author, 200) } : {}),
      ...(problem ? { problem: clip(problem, 200) } : {}),
    },
    // An edited review is a new phase, so it pushes again; a reply doesn't.
    phase: `review:${review.updatedAt}`,
    push: age > PUSH_WITHIN ? 'none' : review.rating <= 3 ? 'alert' : 'passive',
    actions: [
      {
        id: 'reply',
        label: review.reply ? 'Edit reply' : 'Reply',
        style: 'primary',
        input: 'text',
        repeat: true,
        ...(review.reply ? { prefill: clip(review.reply.text, 4000) } : {}),
      },
    ],
    expiresAt: new Date(Date.parse(review.updatedAt) + KEEP_FOR).toISOString(),
  };
}

type InboxStub = DurableObjectStub<Inbox>;

async function upsert(inbox: InboxStub, config: ReviewsConfig, card: CardInput) {
  const reply = await inbox.upsertCard(config.tokenHash, card);
  if (reply.status >= 300) console.warn(`reviews: card ${card.key} refused with ${reply.status}`, JSON.stringify(reply.body));
}

/** Pulls every configured store and upserts a card per recent review. One failing store doesn't stop the others. */
export async function pullReviews(inbox: InboxStub, config: ReviewsConfig, now = Date.now()) {
  for (const app of config.apps) {
    const pulls: [Store, string | undefined, (id: string) => Promise<StoreReview[]>][] = [
      ['appstore', config.appStore && app.appStore, (id) => listAppStoreReviews(config.appStore!, id)],
      ['play', config.play && app.play, (id) => listPlayReviews(config.play!, id)],
    ];
    for (const [store, appId, list] of pulls) {
      if (!appId) continue;
      try {
        for (const review of await list(appId))
          if (now - Date.parse(review.updatedAt) <= KEEP_FOR) await upsert(inbox, config, reviewCard(review, app.name, now));
      } catch (cause) {
        console.error(`reviews: ${store} ${appId} pull failed`, cause);
      }
    }
  }
}

const transient = (cause: unknown) => !(cause instanceof StoreError) || cause.status === 429 || cause.status >= 500;

async function fetchReview(config: ReviewsConfig, store: Store, appId: string, id: string) {
  return store === 'appstore' ? await getAppStoreReview(config.appStore!, appId, id) : await getPlayReview(config.play!, appId, id);
}

/**
 * Posts the replies typed on cards since the last run, oldest first, and
 * refreshes each card from the store. A refused reply is shown on its card; a
 * network or store outage stops here so the next run retries it.
 */
export async function sendReviewReplies(inbox: InboxStub, config: ReviewsConfig, now = Date.now()) {
  let after = await inbox.jobCursor(CURSOR);
  const page = await inbox.listEvents(config.tokenHash, { after, source: 'reviews' });
  if (page.status !== 200) return console.warn(`reviews: events refused with ${page.status}`);
  for (const event of page.body as InboxEvent[]) {
    const target = parseKey(event.key);
    const app = target && config.apps.find((candidate) => (target.store === 'appstore' ? candidate.appStore : candidate.play) === target.appId);
    const text = event.type === 'action' && event.actionId === 'reply' ? event.text?.trim() : undefined;
    const ready = target && app && text && (target.store === 'appstore' ? config.appStore : config.play);
    if (ready) {
      let problem: string | undefined;
      try {
        if (text.length > REPLY_LIMIT[target.store]) problem = `Not sent: ${STORE_NAMES[target.store]} replies are at most ${REPLY_LIMIT[target.store]} characters.`;
        else if (target.store === 'appstore') await replyOnAppStore(config.appStore!, target.id, text);
        else await replyOnPlay(config.play!, target.appId, target.id, text);
      } catch (cause) {
        if (transient(cause)) return console.error(`reviews: reply to ${event.key} will retry`, cause);
        problem = `Not sent: ${clip(cause instanceof Error ? cause.message : String(cause), 150)}`;
      }
      try {
        const review = await fetchReview(config, target.store, target.appId, target.id);
        if (review) await upsert(inbox, config, reviewCard(review, app.name, now, problem));
      } catch (cause) {
        console.error(`reviews: refreshing ${event.key} failed`, cause);
      }
    }
    after = event.seq;
    await inbox.setJobCursor(CURSOR, after);
  }
}
