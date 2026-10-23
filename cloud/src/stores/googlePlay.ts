// Google Play reviews: list, read one, and reply. Needs a service account invited
// in Play Console with "Reply to reviews". Play only lists reviews written or
// edited in the last 7 days, with text, on production builds.

import { signJwt } from './jwt';
import { storeJson, type StoreReview } from './review';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TRANSLATE_TO = 'en';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface Timestamp {
  seconds: string;
  nanos?: number;
}
interface PlayReview {
  reviewId: string;
  authorName?: string;
  comments: {
    userComment?: {
      text: string;
      originalText?: string;
      lastModified: Timestamp;
      starRating: number;
      reviewerLanguage?: string;
      appVersionName?: string;
      device?: string;
      deviceMetadata?: { productName?: string; manufacturer?: string };
    };
    developerComment?: { text: string; lastModified: Timestamp };
  }[];
}

let cached: { email: string; token: string; expires: number } | undefined;

async function accessToken(account: ServiceAccount) {
  const now = Math.floor(Date.now() / 1000);
  if (cached?.email === account.client_email && cached.expires > now) return cached.token;
  const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token';
  const assertion = await signJwt('RS256', account.private_key, {}, { iss: account.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 });
  const { access_token, expires_in } = await storeJson<{ access_token: string; expires_in: number }>(
    await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    }),
    'Google token exchange',
  );
  cached = { email: account.client_email, token: access_token, expires: now + expires_in - 300 };
  return access_token;
}

async function request<T>(account: ServiceAccount, path: string, init: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken(account)}`, 'Content-Type': 'application/json', ...init.headers },
  });
  return storeJson<T>(response, `Google Play ${init.method ?? 'GET'} ${path.split('?')[0]}`);
}

const iso = ({ seconds }: Timestamp) => new Date(Number(seconds) * 1000).toISOString();

function toReview(packageName: string, review: PlayReview): StoreReview | undefined {
  const user = review.comments.find((comment) => comment.userComment)?.userComment;
  if (!user) return undefined;
  const reply = review.comments.find((comment) => comment.developerComment)?.developerComment;
  // Play joins a title to the body with a tab.
  const [first, ...rest] = user.text.split('\t');
  const title = rest.length ? first : undefined;
  const text = rest.length ? rest.join('\t') : user.text;
  const device = [user.deviceMetadata?.manufacturer, user.deviceMetadata?.productName ?? user.device].filter(Boolean).join(' ');
  return {
    store: 'play',
    appId: packageName,
    id: review.reviewId,
    rating: user.starRating,
    ...(title ? { title } : {}),
    text: text.trim(),
    ...(user.originalText && user.originalText !== user.text ? { originalText: user.originalText.replace('\t', '\n') } : {}),
    ...(review.authorName ? { author: review.authorName } : {}),
    ...(user.appVersionName ? { appVersion: user.appVersionName } : {}),
    ...(device ? { device } : {}),
    ...(user.reviewerLanguage ? { locale: user.reviewerLanguage } : {}),
    updatedAt: iso(user.lastModified),
    ...(reply ? { reply: { text: reply.text, at: iso(reply.lastModified) } } : {}),
  };
}

export async function listPlayReviews(account: ServiceAccount, packageName: string) {
  const reviews: StoreReview[] = [];
  let token: string | undefined;
  // The week's reviews, 100 a page. A few pages covers any app this size.
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({ maxResults: '100', translationLanguage: TRANSLATE_TO, ...(token ? { token } : {}) });
    const doc = await request<{ reviews?: PlayReview[]; tokenPagination?: { nextPageToken?: string } }>(
      account,
      `/${encodeURIComponent(packageName)}/reviews?${query}`,
    );
    for (const review of doc.reviews ?? []) {
      const parsed = toReview(packageName, review);
      if (parsed) reviews.push(parsed);
    }
    token = doc.tokenPagination?.nextPageToken;
    if (!token) break;
  }
  return reviews;
}

export async function getPlayReview(account: ServiceAccount, packageName: string, reviewId: string) {
  const query = new URLSearchParams({ translationLanguage: TRANSLATE_TO });
  return toReview(packageName, await request<PlayReview>(account, `/${encodeURIComponent(packageName)}/reviews/${encodeURIComponent(reviewId)}?${query}`));
}

/** Sets the reply, replacing any earlier one. The reviewer is notified only the first time. */
export async function replyOnPlay(account: ServiceAccount, packageName: string, reviewId: string, text: string) {
  await request(account, `/${encodeURIComponent(packageName)}/reviews/${encodeURIComponent(reviewId)}:reply`, {
    method: 'POST',
    body: JSON.stringify({ replyText: text }),
  });
}
