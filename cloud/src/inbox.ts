// One inbox: its tokens, cards, response log and push registrations, in the
// object's own SQLite database. The Worker validates every body before it gets
// here and passes the caller's token hash; this object owns auth because it
// owns the tokens table.
//
// A Durable Object runs one request at a time and `ctx.storage.sql` is
// synchronous, so each check and the write it guards share one
// `transactionSync`. Nothing awaits in between.
import { DurableObject } from 'cloudflare:workers';

import type {
  ApiError,
  Card,
  CardInput,
  CardPatch,
  CardPick,
  CardResponse,
  CardSnapshot,
  DeviceRegistration,
  DeviceTokenRequest,
  DeviceTokenResponse,
  InboxEvent,
  Kind,
  PushLevel,
  StreamMessage,
  TokenRole,
} from './contract';
import { newToken, sha256Hex } from './crypto';
import { sendPush } from './push';

/** Header the Worker uses to pass the caller's token hash on the stream upgrade. */
export const TOKEN_HASH_HEADER = 'x-apollo-token-hash';

export type Failure = { status: 400 | 401 | 403 | 404 | 409 | 422; body: ApiError };
export type Reply<T> = { status: 200 | 201; body: T } | { status: 204; body: null } | Failure;

export type TokenInfo = { id: string; role: TokenRole; name: string; createdAt: string };

type Principal = { id: string; role: TokenRole; name: string };
type CardRow = { data: string };
type EventRow = { seq: number; data: string };
type WithoutSeq<E> = E extends unknown ? Omit<E, 'seq'> : never;

const DEVICE: readonly TokenRole[] = ['device'];
const PRODUCER: readonly TokenRole[] = ['producer', 'connector'];
const CONNECTOR: readonly TokenRole[] = ['connector'];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SNAPSHOT_CLOSED_WINDOW = 7 * DAY;
const RETENTION = 30 * DAY;
const IDEMPOTENCY_WINDOW = DAY;
const EVENTS_PAGE = 500;
/** A claimed push is retried by the alarm if its send never reports back. */
const PUSH_LEASE = MINUTE;
/** Five retries, about ten minutes in total. */
const PUSH_RETRY_DELAYS = [30_000, MINUTE, 2 * MINUTE, 3 * MINUTE, 3.5 * MINUTE];

const DEFAULT_PUSH: Record<Kind, PushLevel> = { briefing: 'alert', approval: 'alert', update: 'passive' };

const fail = (status: Failure['status'], code: string, message: string, card?: Card): Failure => ({
  status,
  body: { error: { code, message, ...(card ? { card } : {}) } },
});
const ok = <T>(body: T, status: 200 | 201 = 200): Reply<T> => ({ status, body });
const noContent: Reply<null> = { status: 204, body: null };
const iso = (ms = Date.now()) => new Date(ms).toISOString();

// Append-only. Each entry runs once, in order; the applied count lives in the
// object's synchronous KV store.
const MIGRATIONS = [
  `
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX tokens_by_name ON tokens (name);

  -- Indexed columns for queries; the full Card lives in data.
  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    key TEXT NOT NULL,
    state TEXT NOT NULL,
    rev INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    push_status TEXT NOT NULL DEFAULT 'none',
    push_attempts INTEGER NOT NULL DEFAULT 0,
    push_next_at INTEGER,
    data TEXT NOT NULL,
    UNIQUE (source, key)
  );

  -- AUTOINCREMENT so seq is never reused after retention deletes old rows.
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL,
    source TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX events_by_card ON events (card_id);

  CREATE TABLE devices (
    expo_push_token TEXT PRIMARY KEY,
    token_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX devices_by_token ON devices (token_id);

  -- Who a card still has to reach. Fixed when the card is created, so a
  -- retry never goes to a phone that registered (or re-registered) later.
  CREATE TABLE push_recipients (
    card_id TEXT NOT NULL,
    expo_push_token TEXT NOT NULL,
    token_id TEXT NOT NULL,
    PRIMARY KEY (card_id, expo_push_token)
  );
  CREATE INDEX push_recipients_by_token ON push_recipients (token_id);

  CREATE TABLE idempotency (
    token_id TEXT NOT NULL,
    key TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (token_id, key)
  );

  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT INTO counters (name, value) VALUES ('rev', 0);
  `,
];

export class Inbox extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.storage.transactionSync(() => {
      const applied = ctx.storage.kv.get<number>('schemaVersion') ?? 0;
      for (const migration of MIGRATIONS.slice(applied)) this.sql.exec(migration);
      ctx.storage.kv.put('schemaVersion', MIGRATIONS.length);
    });
    // Answered by the runtime without waking a hibernated object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // --- Cards -------------------------------------------------------------

  /** Upserts by (source, key). Only a new card is pushed. */
  async upsertCard(tokenHash: string, input: CardInput): Promise<Reply<Card>> {
    const who = this.#authorize(tokenHash, PRODUCER);
    if ('status' in who) return who;

    const { push, ...fields } = input;
    const { card, created, changed, pushing } = this.ctx.storage.transactionSync(() => {
      const existing = this.#cardBy('source = ? AND key = ?', input.source, input.key);
      if (existing && existing.state !== 'open') return { card: existing, created: false, changed: false, pushing: false };
      if (existing) {
        // Producer fields are replaced; state, resolution and push stay put.
        const { id, push, state, resolution, createdAt } = existing;
        const picks = keepDone(fields.picks, existing.picks);
        return { card: this.#commit({ ...fields, picks, id, push, state, resolution, createdAt }), created: false, changed: true, pushing: false };
      }
      const card = this.#commit({ ...fields, id: crypto.randomUUID(), push: push ?? DEFAULT_PUSH[input.kind], state: 'open', createdAt: iso() });
      const pushing = card.push !== 'none' && this.#addRecipients(card.id) > 0;
      if (pushing) this.sql.exec(`UPDATE cards SET push_status = 'pending', push_next_at = ? WHERE id = ?`, Date.now(), card.id);
      return { card, created: true, changed: true, pushing };
    });

    if (changed) this.#broadcast({ type: 'card', card });
    if (pushing) this.ctx.waitUntil(this.#deliverDuePushes());
    await this.#scheduleAlarm();
    return ok(card, created ? 201 : 200);
  }

  async patchCard(tokenHash: string, id: string, patch: CardPatch): Promise<Reply<Card>> {
    const who = this.#authorize(tokenHash, PRODUCER);
    if ('status' in who) return who;

    const result = this.ctx.storage.transactionSync(() => {
      const card = this.#cardBy('id = ?', id);
      if (!card) return fail(404, 'not_found', 'card not found');
      // Only an open card changes state. Closing a closed card is a no-op.
      const { state, ...fields } = patch;
      const next = { ...card, ...fields, state: card.state === 'open' && state ? state : card.state };
      if (JSON.stringify(next) === JSON.stringify(card)) return { card, changed: false };
      return { card: this.#commit(next), changed: true };
    });
    if ('status' in result) return result;

    if (result.changed) {
      this.#broadcast({ type: 'card', card: result.card });
      await this.#scheduleAlarm();
    }
    return ok(result.card);
  }

  /** Every open card plus cards closed in the last 7 days, with the rev they were read at. */
  listCards(tokenHash: string): Reply<CardSnapshot> {
    const who = this.#authorize(tokenHash, DEVICE);
    if ('status' in who) return who;

    return ok(
      this.ctx.storage.transactionSync(() => ({
        rev: this.#rev(),
        cards: this.sql
          .exec<CardRow>(`SELECT data FROM cards WHERE state = 'open' OR updated_at >= ? ORDER BY rev DESC`, iso(Date.now() - SNAPSHOT_CLOSED_WINDOW))
          .toArray()
          .map(parseCard),
      })),
    );
  }

  /**
   * Records a phone's answer. On approvals and updates the first action
   * resolves the card and later ones get 409. A briefing stays open so picks
   * keep working; each of its actions is recorded once and a repeat returns
   * the card unchanged. A replayed Idempotency-Key returns the stored response.
   */
  async respond(tokenHash: string, id: string, response: CardResponse, idempotency: { key: string; bodyHash: string }): Promise<Reply<Card>> {
    const who = this.#authorize(tokenHash, DEVICE);
    if ('status' in who) return who;

    const result = this.ctx.storage.transactionSync((): Failure | { card: Card; replay: boolean } => {
      const [prior] = this.sql
        .exec<{ body_hash: string; response: string }>(
          'SELECT body_hash, response FROM idempotency WHERE token_id = ? AND key = ? AND created_at > ?',
          who.id,
          idempotency.key,
          Date.now() - IDEMPOTENCY_WINDOW,
        )
        .toArray();
      if (prior) {
        return prior.body_hash === idempotency.bodyHash
          ? { card: parseCard({ data: prior.response }), replay: true }
          : fail(422, 'idempotency_mismatch', 'this Idempotency-Key was used with a different body');
      }

      const card = this.#cardBy('id = ?', id);
      if (!card) return fail(404, 'not_found', 'card not found');
      if (card.state !== 'open') return fail(409, 'card_closed', `card is ${card.state}`, card);

      const at = iso();
      const base = { cardId: card.id, source: card.source, key: card.key, at, by: who.name };
      let next: Card;
      let event: WithoutSeq<InboxEvent>;
      if ('actionId' in response) {
        const action = card.actions?.find((a) => a.id === response.actionId && !a.url);
        if (!action) return fail(400, 'unknown_action', 'card has no such recordable action');
        if (card.kind === 'briefing') {
          if (this.#actionRecorded(card.id, action.id)) return { card, replay: true };
          next = card;
        } else {
          next = this.#commit({ ...card, state: 'resolved', resolution: { actionId: action.id, by: who.name, at } });
        }
        event = { ...base, type: 'action', actionId: action.id };
      } else {
        if (!card.picks?.some((p) => p.n === response.pick)) return fail(400, 'unknown_pick', 'card has no such pick');
        const picks = card.picks.map((p) => (p.n === response.pick ? { ...p, done: response.done } : p));
        next = this.#commit({ ...card, picks });
        event = { ...base, type: 'pick', pick: response.pick, done: response.done };
      }

      this.sql.exec('INSERT INTO events (card_id, source, data) VALUES (?, ?, ?)', card.id, card.source, JSON.stringify(event));
      this.sql.exec(
        'INSERT OR REPLACE INTO idempotency (token_id, key, body_hash, response, created_at) VALUES (?, ?, ?, ?, ?)',
        who.id,
        idempotency.key,
        idempotency.bodyHash,
        JSON.stringify(next),
        Date.now(),
      );
      return { card: next, replay: false };
    });

    if ('status' in result) return result;
    if (!result.replay) {
      this.#broadcast({ type: 'card', card: result.card });
      // A resolved card now waits on retention. (A briefing action leaves the
      // card as it was; the broadcast and check are harmless.)
      await this.#scheduleAlarm();
    }
    return ok(result.card);
  }

  /** The response log, oldest first. Producers page with the last seq they saw. */
  listEvents(tokenHash: string, query: { after?: number; source?: string }): Reply<InboxEvent[]> {
    const who = this.#authorize(tokenHash, PRODUCER);
    if ('status' in who) return who;

    const after = query.after ?? 0;
    const rows = query.source
      ? this.sql.exec<EventRow>('SELECT seq, data FROM events WHERE seq > ? AND source = ? ORDER BY seq LIMIT ?', after, query.source, EVENTS_PAGE)
      : this.sql.exec<EventRow>('SELECT seq, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?', after, EVENTS_PAGE);
    return ok(rows.toArray().map((row): InboxEvent => ({ seq: row.seq, ...JSON.parse(row.data) })));
  }

  // --- Devices and tokens -------------------------------------------------

  registerDevice(tokenHash: string, registration: DeviceRegistration): Reply<null> {
    const who = this.#authorize(tokenHash, DEVICE);
    if ('status' in who) return who;

    this.ctx.storage.transactionSync(() => {
      // A push token that moves to a new device token leaves its old owner's
      // pending pushes behind; the new owner decides from here on.
      this.sql.exec('DELETE FROM push_recipients WHERE expo_push_token = ? AND token_id != ?', registration.expoPushToken, who.id);
      this.sql.exec(
        `INSERT INTO devices (expo_push_token, token_id, platform, name, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (expo_push_token) DO UPDATE SET token_id = excluded.token_id, platform = excluded.platform, name = excluded.name`,
        registration.expoPushToken,
        who.id,
        registration.platform,
        registration.name ?? null,
        iso(),
      );
    });
    return noContent;
  }

  unregisterDevice(tokenHash: string): Reply<null> {
    const who = this.#authorize(tokenHash, DEVICE);
    if ('status' in who) return who;

    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM devices WHERE token_id = ?', who.id);
      this.sql.exec('DELETE FROM push_recipients WHERE token_id = ?', who.id);
    });
    return noContent;
  }

  /** Mints a device token named after the connector's device id, revoking any earlier one. */
  async mintDeviceToken(tokenHash: string, request: DeviceTokenRequest): Promise<Reply<DeviceTokenResponse>> {
    const token = newToken();
    const hash = await sha256Hex(token);
    // Authorize after the await so the check and the writes stay in one step.
    const who = this.#authorize(tokenHash, CONNECTOR);
    if ('status' in who) return who;

    this.#revoke(this.#deviceTokenIds(request.name), () => this.#insertToken(hash, 'device', request.name));
    return ok({ token, name: request.name }, 201);
  }

  revokeDeviceToken(tokenHash: string, name: string): Reply<null> {
    const who = this.#authorize(tokenHash, CONNECTOR);
    if ('status' in who) return who;

    this.#revoke(this.#deviceTokenIds(name));
    return noContent;
  }

  // --- Admin (the Worker checks ADMIN_SECRET before calling these) --------

  async createToken(request: { role: TokenRole; name: string }): Promise<TokenInfo & { token: string }> {
    const token = newToken();
    const info = this.#insertToken(await sha256Hex(token), request.role, request.name);
    return { ...info, token };
  }

  listTokens(): TokenInfo[] {
    return this.sql.exec<TokenInfo>('SELECT id, role, name, created_at AS createdAt FROM tokens ORDER BY created_at').toArray();
  }

  revokeToken(id: string): boolean {
    const found = this.sql.exec('SELECT 1 FROM tokens WHERE id = ?', id).toArray().length > 0;
    if (found) this.#revoke([id]);
    return found;
  }

  // --- Stream ------------------------------------------------------------

  /** Accepts the device WebSocket. Hibernation keeps idle sockets free. */
  async fetch(request: Request): Promise<Response> {
    const who = this.#authorize(request.headers.get(TOKEN_HASH_HEADER) ?? '', DEVICE);
    if ('status' in who) return Response.json(who.body, { status: who.status });

    const { 0: client, 1: server } = new WebSocketPair();
    // Tagged with the token id so revocation can find and close it.
    this.ctx.acceptWebSocket(server, [who.id]);
    return new Response(null, { status: 101, webSocket: client });
  }

  // The stream is server to client; anything else a phone sends is ignored.
  async webSocketMessage() {}

  // --- Alarm -------------------------------------------------------------

  /** Settles expired cards, applies retention, and sends due pushes. */
  async alarm() {
    const now = Date.now();
    const { settled, removed } = this.ctx.storage.transactionSync(() => {
      const settled = this.sql
        .exec<CardRow>(`SELECT data FROM cards WHERE state = 'open' AND expires_at <= ?`, iso(now))
        .toArray()
        .map((row) => this.#commit({ ...parseCard(row), state: 'settled' }));

      const cutoff = iso(now - RETENTION);
      this.sql.exec(`DELETE FROM events WHERE card_id IN (SELECT id FROM cards WHERE state != 'open' AND updated_at < ?)`, cutoff);
      const removed = this.sql
        .exec<{ id: string }>(`DELETE FROM cards WHERE state != 'open' AND updated_at < ? RETURNING id`, cutoff)
        .toArray()
        .map((row) => row.id);
      this.sql.exec('DELETE FROM idempotency WHERE created_at <= ?', now - IDEMPOTENCY_WINDOW);
      return { settled, removed };
    });

    this.#broadcast(
      ...settled.map((card): StreamMessage => ({ type: 'card', card })),
      ...removed.map((id): StreamMessage => ({ type: 'remove', id })),
    );
    await this.#deliverDuePushes();
    await this.#scheduleAlarm();
  }

  // --- Internals ---------------------------------------------------------

  #authorize(tokenHash: string, roles: readonly TokenRole[]): Principal | Failure {
    const [token] = this.sql.exec<Principal>('SELECT id, role, name FROM tokens WHERE hash = ?', tokenHash).toArray();
    if (!token) return fail(401, 'unauthorized', 'token is missing, invalid or revoked');
    if (!roles.includes(token.role)) return fail(403, 'forbidden', `needs a ${roles.join(' or ')} token`);
    return token;
  }

  #insertToken(hash: string, role: TokenRole, name: string): TokenInfo {
    const info: TokenInfo = { id: crypto.randomUUID(), role, name, createdAt: iso() };
    this.sql.exec('INSERT INTO tokens (id, hash, role, name, created_at) VALUES (?, ?, ?, ?, ?)', info.id, hash, role, name, info.createdAt);
    return info;
  }

  #deviceTokenIds(name: string) {
    return this.sql
      .exec<{ id: string }>(`SELECT id FROM tokens WHERE role = 'device' AND name = ?`, name)
      .toArray()
      .map((row) => row.id);
  }

  /** Deletes tokens with their push registrations and pending pushes, then closes their sockets. */
  #revoke(ids: string[], alsoInTransaction?: () => void) {
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) {
        this.sql.exec('DELETE FROM tokens WHERE id = ?', id);
        this.sql.exec('DELETE FROM devices WHERE token_id = ?', id);
        this.sql.exec('DELETE FROM push_recipients WHERE token_id = ?', id);
        this.sql.exec('DELETE FROM idempotency WHERE token_id = ?', id);
      }
      alsoInTransaction?.();
    });
    for (const id of ids) {
      for (const ws of this.ctx.getWebSockets(id)) ws.close(1008, 'token revoked');
    }
  }

  #cardBy(where: string, ...bindings: string[]): Card | undefined {
    const [row] = this.sql.exec<CardRow>(`SELECT data FROM cards WHERE ${where}`, ...bindings).toArray();
    return row && parseCard(row);
  }

  #actionRecorded(cardId: string, actionId: string) {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM events WHERE card_id = ? AND json_extract(data, '$.type') = 'action' AND json_extract(data, '$.actionId') = ? LIMIT 1`,
          cardId,
          actionId,
        )
        .toArray().length > 0
    );
  }

  #rev() {
    return this.sql.exec<{ value: number }>(`SELECT value FROM counters WHERE name = 'rev'`).one().value;
  }

  /** Writes a card with the next inbox rev. Every card write goes through here. */
  #commit(card: Omit<Card, 'rev' | 'updatedAt'>): Card {
    const rev = this.sql.exec<{ value: number }>(`UPDATE counters SET value = value + 1 WHERE name = 'rev' RETURNING value`).one().value;
    const next: Card = { ...card, rev, updatedAt: iso() };
    this.sql.exec(
      `INSERT INTO cards (id, source, key, state, rev, updated_at, expires_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, rev = excluded.rev, updated_at = excluded.updated_at,
         expires_at = excluded.expires_at, data = excluded.data`,
      next.id,
      next.source,
      next.key,
      next.state,
      next.rev,
      next.updatedAt,
      next.expiresAt ?? null,
      JSON.stringify(next),
    );
    return next;
  }

  #broadcast(...messages: StreamMessage[]) {
    if (messages.length === 0) return;
    const frames = messages.map((message) => JSON.stringify(message));
    for (const ws of this.ctx.getWebSockets()) {
      try {
        for (const frame of frames) ws.send(frame);
      } catch {
        // The socket is closing; the phone reconciles when it reconnects.
      }
    }
  }

  /** Fixes a new card's recipients to the phones registered right now. Returns how many. */
  #addRecipients(cardId: string) {
    this.sql.exec('INSERT INTO push_recipients (card_id, expo_push_token, token_id) SELECT ?, expo_push_token, token_id FROM devices', cardId);
    return this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM push_recipients WHERE card_id = ?', cardId).one().n;
  }

  /**
   * Sends every push that is due to the recipients it still owes. Claiming is
   * one statement that runs before the first await, so the alarm and an upsert
   * can't send the same card twice. Recipients with an ok ticket are done; the
   * rest are retried, up to five times.
   */
  async #deliverDuePushes() {
    const now = Date.now();
    const due = this.sql
      .exec<{ id: string; data: string; push_attempts: number }>(
        `UPDATE cards SET push_next_at = ? WHERE push_status = 'pending' AND push_next_at <= ? RETURNING id, data, push_attempts`,
        now + PUSH_LEASE,
        now,
      )
      .toArray();

    await Promise.all(
      due.map(async (row) => {
        const card = parseCard(row);
        const recipients = this.sql
          .exec<{ expo_push_token: string }>('SELECT expo_push_token FROM push_recipients WHERE card_id = ?', row.id)
          .toArray()
          .map((r) => r.expo_push_token);
        const done = (status: 'sent' | 'failed' | 'skipped') => {
          this.sql.exec('DELETE FROM push_recipients WHERE card_id = ?', row.id);
          this.sql.exec('UPDATE cards SET push_status = ?, push_next_at = NULL WHERE id = ?', status, row.id);
        };
        // Closed before it went out, or every recipient was revoked.
        if (card.state !== 'open' || recipients.length === 0) return this.ctx.storage.transactionSync(() => done('skipped'));

        const outcome = await sendPush(card, recipients, this.env.EXPO_ACCESS_TOKEN);
        this.ctx.storage.transactionSync(() => {
          if (outcome.status === 'failed') return done('failed');
          if (outcome.status === 'tickets') {
            for (const token of outcome.delivered) this.sql.exec('DELETE FROM push_recipients WHERE card_id = ? AND expo_push_token = ?', row.id, token);
            for (const token of outcome.unregistered) {
              this.sql.exec('DELETE FROM devices WHERE expo_push_token = ?', token);
              this.sql.exec('DELETE FROM push_recipients WHERE expo_push_token = ?', token);
            }
          }
          // Revocation may also have removed recipients while the send was in flight.
          const left = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM push_recipients WHERE card_id = ?', row.id).one().n;
          if (left === 0) return done('sent');
          const delay = PUSH_RETRY_DELAYS[row.push_attempts];
          if (delay === undefined) {
            console.warn(`push for card ${row.id} gave up with ${left} recipient(s) left`);
            return done('failed');
          }
          this.sql.exec('UPDATE cards SET push_attempts = push_attempts + 1, push_next_at = ? WHERE id = ?', Date.now() + delay, row.id);
        });
      }),
    );
    if (due.length > 0) await this.#scheduleAlarm();
  }

  /**
   * Keeps one alarm at the earliest of: the next card expiry, the next due
   * push, and a daily sweep while anything awaits retention.
   */
  async #scheduleAlarm() {
    const { expiry, push, sweep } = this.sql
      .exec<{ expiry: string | null; push: number | null; sweep: number }>(
        `SELECT
          (SELECT min(expires_at) FROM cards WHERE state = 'open') AS expiry,
          (SELECT min(push_next_at) FROM cards WHERE push_status = 'pending') AS push,
          EXISTS (SELECT 1 FROM cards WHERE state != 'open') OR EXISTS (SELECT 1 FROM idempotency) AS sweep`,
      )
      .one();
    const candidates = [expiry ? Date.parse(expiry) : null, push, sweep ? Date.now() + DAY : null].filter((at) => at !== null);
    if (candidates.length === 0) return;
    const next = Math.min(...candidates);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current) await this.ctx.storage.setAlarm(next);
  }
}

function parseCard(row: CardRow): Card {
  return JSON.parse(row.data);
}

/** A re-upserted pick keeps its done value when one with the same n and text existed. */
function keepDone(next: CardPick[] | undefined, previous: CardPick[] | undefined) {
  return next?.map((pick) => {
    const match = previous?.find((p) => p.n === pick.n && p.text === pick.text);
    return match ? { ...pick, done: match.done } : pick;
  });
}
