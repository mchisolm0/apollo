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

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/cards` | producer | Upsert a `CardInput` by `(source, key)`. Returns the `Card`. Pushes only on first insert. |
| `PATCH` | `/v1/cards/:id` | producer | Change `state`, `title`, `body`, `picks`, `meta` or `expiresAt`, e.g. resolve an approval handled elsewhere. |
| `GET` | `/v1/cards?since=<iso>` | device | Open cards plus anything updated since `since`. |
| `GET` | `/v1/stream` | device | WebSocket of `StreamMessage`s (hibernatable). |
| `POST` | `/v1/cards/:id/respond` | device | Body `CardResponse`. Idempotent with `Idempotency-Key`. An action resolves the card; a pick toggles it. Appends an `InboxEvent`. |
| `GET` | `/v1/events?after=<seq>&source=<s>` | producer | Response log, oldest first. Producers keep their own cursor. |
| `POST` | `/v1/devices` | device | Register a `DeviceRegistration` for push. |
| `DELETE` | `/v1/devices/self` | device | Stop push to this device. |
| `POST` | `/v1/device-tokens` | connector | Mint a `device` token for a phone the connector already trusts. Returns `{ token, name }`. |
| `GET` | `/v1/health` | none | Liveness. |

## Push

The Worker sends through the Expo push API. Each push carries `data: { cardId, source, kind }`, uses the source as the thread id, and sets `categoryId`:

- `apollo.approval` for approval cards. Buttons: Approve (`approve`), Open (opens the app), Reject (`reject`, destructive).
- `apollo.briefing` for the morning card. Tapping opens the inbox.

`passive` maps to the iOS passive interruption level. Updates default to passive.

## Flows

- **Producer posts.** `POST /v1/cards`. If the Worker can't be reached, producers fall back to Discord through `hermes send`. Discord is failover only.
- **Phone responds.** `POST /v1/cards/:id/respond`, from the inbox or a notification button. The producer sees it on its next `GET /v1/events` and acts (approves a deployment, updates picks), then may `PATCH` the card.
- **Hermes approvals.** The connector posts an approval card with source `hermes` and key `<runId>:<requestId>`, reads `approve`/`reject` events, and answers Hermes with `once`/`deny`. If the approval is answered in the app thread instead, the connector resolves the card.
- **Pairing.** During pair exchange, or when an already paired phone calls the connector, the connector mints a device token and returns `{ cloudUrl, cloudToken }`. One QR code pairs both.

## Retention

Settled and resolved cards and their events are deleted after 30 days. Expired cards settle on their own through the object's alarm.
