// App Store Connect customer reviews: list, read one, and reply.
// Needs an API key with the Customer Support role (or higher).

import { signJwt } from './jwt';
import { storeJson, type StoreReview } from './review';

const API = 'https://api.appstoreconnect.apple.com/v1';
const PAGE = 50;

export interface AppStoreKey {
  issuerId: string;
  keyId: string;
  privateKey: string;
}

interface Resource<A> {
  id: string;
  type: string;
  attributes: A;
  relationships?: { response?: { data: { id: string; type: string } | null } };
}
interface ReviewAttributes {
  rating: number;
  title?: string;
  body?: string;
  reviewerNickname?: string;
  createdDate: string;
  territory?: string;
}
interface ResponseAttributes {
  responseBody: string;
  lastModifiedDate?: string;
  state?: 'PUBLISHED' | 'PENDING_PUBLISH';
}
interface Document<D> {
  data: D;
  included?: Resource<ResponseAttributes>[];
}

let cached: { key: string; token: string; expires: number } | undefined;

/** A token lasts 20 minutes at most; this one is reused for 15. */
async function token({ issuerId, keyId, privateKey }: AppStoreKey) {
  const now = Math.floor(Date.now() / 1000);
  if (cached?.key === keyId && cached.expires > now) return cached.token;
  const jwt = await signJwt('ES256', privateKey, { kid: keyId }, { iss: issuerId, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1' });
  cached = { key: keyId, token: jwt, expires: now + 15 * 60 };
  return jwt;
}

async function request<T>(key: AppStoreKey, path: string, init: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await token(key)}`, 'Content-Type': 'application/json', ...init.headers },
  });
  return storeJson<T>(response, `App Store Connect ${init.method ?? 'GET'} ${path.split('?')[0]}`);
}

function toReview(appId: string, review: Resource<ReviewAttributes>, included: Resource<ResponseAttributes>[] = []): StoreReview {
  const responseId = review.relationships?.response?.data?.id;
  const response = included.find((item) => item.type === 'customerReviewResponses' && item.id === responseId)?.attributes;
  const { rating, title, body, reviewerNickname, createdDate, territory } = review.attributes;
  return {
    store: 'appstore',
    appId,
    id: review.id,
    rating,
    ...(title ? { title } : {}),
    text: body ?? '',
    ...(reviewerNickname ? { author: reviewerNickname } : {}),
    ...(territory ? { locale: territory } : {}),
    updatedAt: createdDate,
    ...(response
      ? { reply: { text: response.responseBody, ...(response.lastModifiedDate ? { at: response.lastModifiedDate } : {}), pending: response.state === 'PENDING_PUBLISH' } }
      : {}),
  };
}

/** The newest reviews first. Apple keeps every review, so one page each run is enough to catch new ones. */
export async function listAppStoreReviews(key: AppStoreKey, appId: string) {
  const doc = await request<Document<Resource<ReviewAttributes>[]>>(key, `/apps/${encodeURIComponent(appId)}/customerReviews?sort=-createdDate&limit=${PAGE}&include=response`);
  return doc.data.map((review) => toReview(appId, review, doc.included));
}

export async function getAppStoreReview(key: AppStoreKey, appId: string, reviewId: string) {
  const doc = await request<Document<Resource<ReviewAttributes>>>(key, `/customerReviews/${encodeURIComponent(reviewId)}?include=response`);
  return toReview(appId, doc.data, doc.included);
}

/** Creates the reply, or replaces the one already there. Apple reviews it before it shows. */
export async function replyOnAppStore(key: AppStoreKey, reviewId: string, text: string) {
  await request(key, '/customerReviewResponses', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'customerReviewResponses',
        attributes: { responseBody: text },
        relationships: { review: { data: { type: 'customerReviews', id: reviewId } } },
      },
    }),
  });
}
