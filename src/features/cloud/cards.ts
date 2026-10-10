import { CATEGORY, KINDS, SOURCES, type Card, type CardAction, type CardSnapshot, type CardPick, type CardState, type PushLevel, type StreamMessage } from '../../../cloud/src/contract.ts';

const STATES = ['open', 'resolved', 'settled'] as const satisfies readonly CardState[];
const PUSH_LEVELS = ['alert', 'passive', 'none'] as const satisfies readonly PushLevel[];
const ACTION_STYLES = ['primary', 'default', 'destructive'] as const satisfies readonly NonNullable<CardAction['style']>[];
const ID = /^[A-Za-z0-9._:~-]{1,256}$/u;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseAction(value: unknown): CardAction | undefined {
  if (!isObject(value)) return undefined;
  const id = text(value.id);
  const label = text(value.label);
  if (!id || !label) return undefined;
  const style = oneOf(ACTION_STYLES, value.style);
  const url = text(value.url);
  return { id, label, ...(style ? { style } : {}), ...(url ? { url } : {}) };
}

function parsePick(value: unknown): CardPick | undefined {
  if (!isObject(value)) return undefined;
  const { n, done } = value;
  const label = text(value.text);
  if (typeof n !== 'number' || !Number.isInteger(n) || label === undefined || typeof done !== 'boolean') return undefined;
  const sub = text(value.sub);
  return { n, text: label, done, ...(sub ? { sub } : {}) };
}

function parseResolution(value: unknown): Card['resolution'] {
  if (!isObject(value)) return undefined;
  const actionId = text(value.actionId);
  const by = text(value.by);
  const at = text(value.at);
  return actionId && by && at ? { actionId, by, at } : undefined;
}

function parseMeta(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** Validates a card from the Worker, the stream or local cache. Unknown fields are dropped. */
export function parseCard(value: unknown): Card | undefined {
  if (!isObject(value)) return undefined;
  const source = oneOf(SOURCES, value.source);
  const kind = oneOf(KINDS, value.kind);
  const state = oneOf(STATES, value.state);
  const push = oneOf(PUSH_LEVELS, value.push) ?? 'none';
  const { id, key, title, createdAt, updatedAt, rev } = value;
  if (typeof id !== 'string' || !ID.test(id) || !source || !kind || !state || typeof key !== 'string' || typeof title !== 'string'
    || typeof createdAt !== 'string' || typeof updatedAt !== 'string' || typeof rev !== 'number' || !Number.isFinite(rev)) return undefined;
  const body = text(value.body);
  const url = text(value.url);
  const expiresAt = text(value.expiresAt);
  const actions = Array.isArray(value.actions) ? value.actions.map(parseAction).filter((action) => action !== undefined) : undefined;
  const picks = Array.isArray(value.picks) ? value.picks.map(parsePick).filter((pick) => pick !== undefined) : undefined;
  const meta = parseMeta(value.meta);
  const resolution = parseResolution(value.resolution);
  return {
    id, rev, source, key, kind, title, state, push, createdAt, updatedAt,
    ...(body ? { body } : {}), ...(url ? { url } : {}), ...(expiresAt ? { expiresAt } : {}),
    ...(actions ? { actions } : {}), ...(picks ? { picks } : {}), ...(meta ? { meta } : {}), ...(resolution ? { resolution } : {}),
  };
}

export function parseCards(value: unknown): Card[] {
  return Array.isArray(value) ? value.map(parseCard).filter((card) => card !== undefined) : [];
}

export function parseStreamMessage(data: unknown): StreamMessage | undefined {
  if (typeof data !== 'string') return undefined;
  let value: unknown;
  try { value = JSON.parse(data); } catch { return undefined; }
  if (!isObject(value)) return undefined;
  if (value.type === 'remove' && typeof value.id === 'string') return { type: 'remove', id: value.id };
  const card = value.type === 'card' ? parseCard(value.card) : undefined;
  return card ? { type: 'card', card } : undefined;
}

/** A card replaces the local copy only when its `rev` is higher, whatever path it came by. */
export function applyCard(cards: readonly Card[], card: Card): readonly Card[] {
  const index = cards.findIndex((candidate) => candidate.id === card.id);
  if (index === -1) return [...cards, card];
  if (cards[index].rev >= card.rev) return cards;
  return cards.map((candidate, position) => position === index ? card : candidate);
}

export function applyStreamMessage(cards: readonly Card[], message: StreamMessage): readonly Card[] {
  return message.type === 'card' ? applyCard(cards, message.card) : cards.filter((card) => card.id !== message.id);
}

export function parseSnapshot(value: unknown): CardSnapshot | undefined {
  if (!isObject(value) || typeof value.rev !== 'number' || !Number.isFinite(value.rev) || !Array.isArray(value.cards)) return undefined;
  return { rev: value.rev, cards: parseCards(value.cards) };
}

/**
 * Merges a full `GET /v1/cards` into the local set (docs/cloud-inbox.md, Reconciling).
 * Higher `rev` wins per card. A local card missing from the snapshot survives only when
 * its `rev` is above the snapshot's, meaning the stream delivered it after the snapshot
 * was taken. `removed` holds ids the stream removed while the request was in flight.
 */
export function mergeSnapshot(local: readonly Card[], snapshot: CardSnapshot, removed: ReadonlySet<string> = new Set()): readonly Card[] {
  const merged = new Map(snapshot.cards.filter((card) => !removed.has(card.id)).map((card) => [card.id, card]));
  for (const card of local) {
    const remote = merged.get(card.id);
    if (remote ? card.rev > remote.rev : card.rev > snapshot.rev && !removed.has(card.id)) merged.set(card.id, card);
  }
  return [...merged.values()];
}

export type CloudNotificationIntent =
  | { type: 'respond'; cardId: string; actionId: 'approve' | 'reject'; key: string }
  | { type: 'open'; cardId: string; kind?: Card['kind'] };

type ResponseLike = {
  actionIdentifier: string;
  notification: { request: { identifier: string; content: { data?: unknown; categoryIdentifier?: string | null } } };
};

/**
 * Maps a notification response to what the app should do. Only `apollo.approval`
 * notifications may answer a card from the lock screen. The idempotency key is
 * derived from the notification so a duplicate delivery of the same tap collapses.
 */
export function cloudNotificationIntent(response: ResponseLike): CloudNotificationIntent | undefined {
  const { data, categoryIdentifier } = response.notification.request.content;
  if (!isObject(data) || typeof data.cardId !== 'string' || !ID.test(data.cardId)) return undefined;
  const kind = oneOf(KINDS, data.kind);
  const actionId = response.actionIdentifier === 'approve' || response.actionIdentifier === 'reject' ? response.actionIdentifier : undefined;
  if (actionId) {
    if (categoryIdentifier !== CATEGORY.approval && kind !== 'approval') return undefined;
    return { type: 'respond', cardId: data.cardId, actionId, key: `notification:${response.notification.request.identifier}:${actionId}` };
  }
  return { type: 'open', cardId: data.cardId, ...(kind ? { kind } : {}) };
}
