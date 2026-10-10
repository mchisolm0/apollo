// Request body validators. The Worker runs these before anything reaches the
// Durable Object, so the object only ever sees well-formed contract types.
// Undeclared keys are dropped ('+': 'delete') so stray fields never get stored.
import { type } from 'arktype';

import { KINDS, SOURCES } from './contract';

const source = type.enumerated(...SOURCES);
const role = type("'device' | 'producer' | 'connector'");
const name = type('0 < string <= 100');

/** Accepts any ISO time and normalizes it to UTC, so stored times sort as strings. */
const isoTime = type('string.date.iso.parse').pipe((date) => date.toISOString());

const action = type({
  id: '0 < string <= 64',
  label: '0 < string <= 80',
  'style?': "'primary' | 'default' | 'destructive'",
  'url?': 'string.url',
  '+': 'delete',
});

const pick = type({
  n: 'number.integer >= 0',
  text: '0 < string <= 200',
  'sub?': 'string <= 200',
  done: 'boolean',
  '+': 'delete',
});

const meta = type.Record('0 < string <= 40', 'string <= 200');

export const CardInput = type({
  source,
  key: '0 < string <= 200',
  kind: type.enumerated(...KINDS),
  title: '0 < string <= 200',
  'body?': 'string <= 4000',
  'url?': 'string.url',
  'actions?': action.array().atMostLength(6),
  'picks?': pick.array().atMostLength(3),
  'meta?': meta,
  'push?': "'alert' | 'passive' | 'none'",
  'expiresAt?': isoTime,
  '+': 'delete',
}).narrow((card, ctx) => card.picks === undefined || card.kind === 'briefing' || ctx.reject({ path: ['picks'], description: 'only on briefing cards' }));

export const CardPatch = type({
  'title?': '0 < string <= 200',
  'body?': 'string <= 4000',
  'meta?': meta,
  'expiresAt?': isoTime,
  'state?': "'resolved' | 'settled'",
  '+': 'delete',
});

// The two variants are exact, so a body mixing actionId with pick is rejected.
export const CardResponse = type({ actionId: '0 < string <= 64', '+': 'reject' }).or({
  pick: 'number.integer >= 0',
  done: 'boolean',
  '+': 'reject',
});

export const DeviceRegistration = type({
  expoPushToken: /^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]{1,200}\]$/,
  platform: "'ios' | 'android'",
  'name?': name,
  '+': 'delete',
});

export const DeviceTokenRequest = type({ name, '+': 'delete' });

export const TokenRequest = type({ role, name, '+': 'delete' });

export const EventsQuery = type({
  'after?': type('string.integer.parse').to('number.integer >= 0'),
  'source?': source,
  '+': 'delete',
});

export const IdempotencyKey = type('0 < string <= 200');
