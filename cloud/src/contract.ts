// Wire contract for the Apollo cloud inbox (a Cloudflare Worker with one
// Durable Object per inbox). The Worker, the app, the mini connector and the
// producers in dotfiles all build against this file. It has no imports so
// any of them can depend on it. See docs/cloud-inbox.md.

export const SOURCES = ['morning', 'preview', 'fleet', 'digest', 'jobs', 'hermes'] as const;
export type Source = (typeof SOURCES)[number];

/**
 * briefing: the morning card, pinned at the top of the inbox while open.
 * approval: something waiting on Matthew; shown under "Needs you".
 * update: FYI; collapsed under "Updates".
 */
export const KINDS = ['briefing', 'approval', 'update'] as const;
export type Kind = (typeof KINDS)[number];

/** alert: normal push. passive: delivered silently. none: inbox only. */
export type PushLevel = 'alert' | 'passive' | 'none';

export type CardState = 'open' | 'resolved' | 'settled';

/**
 * Approval cards use the fixed ids `approve` and `reject` so the phone can
 * offer them as notification buttons (category `apollo.approval`). An action
 * with a `url` opens that URL and records nothing.
 */
export interface CardAction {
  id: string;
  label: string;
  style?: 'primary' | 'default' | 'destructive';
  url?: string;
}

export interface CardPick {
  n: number;
  text: string;
  sub?: string;
  done: boolean;
}

/** What a producer sends. Upserts by (source, key). */
export interface CardInput {
  source: Source;
  /** Producer-chosen dedupe key, e.g. `run:123` or `2026-10-09`. */
  key: string;
  kind: Kind;
  title: string;
  body?: string;
  url?: string;
  actions?: CardAction[];
  /** Briefing cards only, at most 3. */
  picks?: CardPick[];
  /** Short labeled lines, e.g. { calendar: '10:00 · 14:30', waiting: 'Scryve #335' }. */
  meta?: Record<string, string>;
  /** Defaults: approval and briefing alert, update passive. Re-upserts never re-push. */
  push?: PushLevel;
  /** ISO time after which the card settles on its own. */
  expiresAt?: string;
}

export interface Card extends Omit<CardInput, 'push'> {
  id: string;
  /** Inbox-wide counter bumped on every write to any card. Higher wins on the phone. */
  rev: number;
  push: PushLevel;
  state: CardState;
  resolution?: { actionId: string; by: string; at: string };
  createdAt: string;
  updatedAt: string;
}

/** What a producer sends to PATCH /v1/cards/:id. Omitted fields stay as they are. */
export type CardPatch = Partial<Pick<CardInput, 'title' | 'body' | 'meta' | 'expiresAt'>> & {
  state?: 'resolved' | 'settled';
};

/**
 * What the phone sends to POST /v1/cards/:id/respond. A pick response sets
 * `done` to the given value; it never toggles.
 */
export type CardResponse =
  | { actionId: string; pick?: never; done?: never }
  | { pick: number; done: boolean; actionId?: never };

/** One row of the response log producers read from GET /v1/events. */
export type InboxEvent = {
  seq: number;
  cardId: string;
  source: Source;
  key: string;
  at: string;
  /** Token name of the device that responded. */
  by: string;
} & ({ type: 'action'; actionId: string } | { type: 'pick'; pick: number; done: boolean });

/** GET /v1/cards. `rev` is the inbox counter at the moment the snapshot was taken. */
export interface CardSnapshot {
  rev: number;
  cards: Card[];
}

/** Messages the Worker sends on the device WebSocket (GET /v1/stream). */
export type StreamMessage = { type: 'card'; card: Card } | { type: 'remove'; id: string };

export type TokenRole = 'device' | 'producer' | 'connector';

/** POST /v1/device-tokens. `name` is the connector's device id; minting again for it revokes the old token. */
export interface DeviceTokenRequest {
  name: string;
}
export interface DeviceTokenResponse {
  token: string;
  name: string;
}

export interface ApiError {
  error: { code: string; message: string; card?: Card };
}

export interface DeviceRegistration {
  expoPushToken: string;
  platform: 'ios' | 'android';
  name?: string;
}

/** Notification category ids the app registers. */
export const CATEGORY = { approval: 'apollo.approval', briefing: 'apollo.briefing' } as const;
