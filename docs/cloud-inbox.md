# Cloud inbox

Apollo's cloud inbox holds cards (the morning card, approvals, updates) and sends push. It runs on Cloudflare as a Worker with one Durable Object per inbox, and each object has its own SQLite database. Hermes chat does not go through it: the phone still talks to the connector on mini over Tailscale.

Types live in [`cloud/src/contract.ts`](../cloud/src/contract.ts).

## Auth

Every request carries `Authorization: Bearer <token>`. The Durable Object stores only SHA-256 hashes. Tokens have a role and a name:

| Role | Holder | Can |
| --- | --- | --- |
| `device` | a phone | read cards, stream, respond, register for push |
| `producer` | a machine or routine (`mini`, `nobara`) | post and patch cards, read events |
| `connector` | the mini connector | everything `producer` can, plus mint `device` tokens |

The admin secret is a Worker secret. Only the token CLI (`cloud/cli`) uses it, through `/admin/*`, to create and revoke tokens. It never lives on a phone.

## Endpoints

Errors are `ApiError` (`{ error: { code, message } }`) with a matching HTTP status.

| Method | Path | Role | Request → response |
| --- | --- | --- | --- |
| `POST` | `/v1/cards` | producer | `CardInput` → `Card`. Upserts by `(source, key)`; see Rules. |
| `PATCH` | `/v1/cards/:id` | producer | `CardPatch` → `Card`. Resolving a card that is already closed is a no-op that returns it. |
| `GET` | `/v1/cards` | device | → `CardSnapshot` (`{ rev, cards }`): every open card plus cards closed in the last 7 days, read atomically with the inbox `rev`. |
| `GET` | `/v1/stream` | device | WebSocket of `StreamMessage`s (hibernatable). Auth uses the `Authorization` header. A text `ping` is answered with `pong`. |
| `POST` | `/v1/cards/:id/respond` | device | `CardResponse` → `Card`. Requires `Idempotency-Key`. `409 card_closed` (with `error.card`) if the card isn't open. |
| `GET` | `/v1/events?after=<seq>&source=<s>` | producer | → `InboxEvent[]`, oldest first, at most 500. Page with the last `seq`. |
| `POST` | `/v1/devices` | device | `DeviceRegistration` → 204. |
| `DELETE` | `/v1/devices/self` | device | → 204. Stops push to this device. |
| `POST` | `/v1/device-tokens` | connector | `DeviceTokenRequest` → `DeviceTokenResponse`. Revokes any earlier token with that name. |
| `DELETE` | `/v1/device-tokens/:name` | connector | → 204. Called when the connector revokes a phone. |
| `POST` | `/admin/tokens` | admin secret | `{ role, name }` → `{ id, token, role, name }`. The only time the raw token is shown. |
| `GET` | `/admin/tokens` | admin secret | → `{ id, role, name, createdAt }[]`. |
| `DELETE` | `/admin/tokens/:id` | admin secret | → 204. |
| `GET` | `/v1/health` | none | Liveness. |

## Rules

- **One writer.** The Durable Object handles one request at a time, so every check below happens in the same transaction as the write it guards.
- **Responding.** Only open cards accept responses. An action resolves the card and appends one `action` event; the first response wins and later ones get `409 card_closed`. A pick sets `done` and appends one `pick` event; it never toggles.
- **Idempotency.** `Idempotency-Key` is scoped to the token and kept for 24 hours alongside the event it produced. A replay returns the stored response and appends nothing. Reusing a key with a different body is `422 idempotency_mismatch`.
- **Upserts.** An upsert never changes `state`, `resolution` or push status. A closed card stays closed and is returned as is. For an open card the producer's fields are replaced, but a pick keeps its `done` value when a pick with the same `n` and `text` existed.
- **Events.** `seq` increases across the whole inbox and is never reused, even after retention deletes old events.
- **Push.** A card is pushed once. Delivery state is stored on the card, and the object's alarm retries a failed Expo send up to 5 times over 10 minutes. Upserts never trigger another push.
- **Reconciling.** Every card write bumps the inbox-wide `rev` counter. The phone opens the stream first, then does a full `GET /v1/cards` on launch, on foreground and after the stream reconnects. When merging, a card with a higher `rev` always wins, whether it came from the stream or the snapshot. A local card missing from the snapshot is dropped if its `rev` is at or below the snapshot's `rev`.
- **Revocation.** Deleting a device token also closes its open WebSockets, deletes its push registrations and drops its pending pushes, all in one step.

## Push

The Worker sends through the Expo push API. Each push carries `data: { cardId, source, kind }`, uses the source as the thread id, and sets `categoryId`:

- `apollo.approval` for approval cards. Buttons: Approve (`approve`), Open (opens the app), Reject (`reject`, destructive).
- `apollo.briefing` for the morning card. Tapping opens the inbox.

`passive` maps to the iOS passive interruption level and, on Android, to an `updates` channel with low importance and no sound. Alerts use the `alerts` channel. Updates default to passive.

## Flows

- **Producer posts.** `POST /v1/cards`. If the Worker can't be reached, producers fall back to Discord through `hermes send`. Discord is failover only.
- **Phone responds.** `POST /v1/cards/:id/respond`, from the inbox or a notification button. The producer sees it on its next `GET /v1/events` and acts (approves a deployment, updates picks), then may `PATCH` the card.
- **Hermes approvals.** The connector posts an approval card with source `hermes` and key `<runId>:<requestId>`, reads `approve`/`reject` events, and answers Hermes with `once`/`deny`. If the approval is answered in the app thread instead, the connector resolves the card.
- **Pairing.** During pair exchange, or when an already paired phone calls the connector, the connector mints a device token named after its own device id and includes `cloud: { url, token }` in its response (both pair exchange and `POST /v1/apollo/cloud-token`). One QR code pairs both. Revoking the phone on the connector also deletes its cloud token.

## Retention

Closed cards and their events are deleted after 30 days. Event sequence numbers keep counting. Expired cards settle on their own through the object's alarm.
