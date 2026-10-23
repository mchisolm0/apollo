// One store review, the same shape for both stores.

export type Store = 'appstore' | 'play';

export interface StoreApp {
  /** Shown on cards, e.g. "Scryve". */
  name: string;
  /** App Store Connect app id, e.g. "6798955244". */
  appStore?: string;
  /** Google Play package, e.g. "com.sowinghope.count". */
  play?: string;
}

export interface StoreReview {
  store: Store;
  /** The app's id in that store: the App Store Connect id or the Play package. */
  appId: string;
  id: string;
  rating: number;
  title?: string;
  text: string;
  /** The reviewer's own words when `text` is a translation. */
  originalText?: string;
  author?: string;
  appVersion?: string;
  device?: string;
  /** App Store territory or Play reviewer language. */
  locale?: string;
  /** Changes when the reviewer edits the review. */
  updatedAt: string;
  reply?: { text: string; at?: string; pending?: boolean };
}

/** The most a store accepts in a reply. */
export const REPLY_LIMIT: Record<Store, number> = { appstore: 5970, play: 350 };

export class StoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function storeJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new StoreError(response.status, `${what} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json<T>();
}
