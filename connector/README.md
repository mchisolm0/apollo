# Apollo connector

The connector is a small Node 22+ process that keeps Hermes on loopback while exposing a paired, revocable mobile API over an HTTPS transport such as Tailscale Serve.

```sh
HERMES_API_KEY=... node connector/cli.mjs serve
node connector/cli.mjs pair --tailscale
node connector/cli.mjs devices
node connector/cli.mjs revoke DEVICE_ID
```

`HERMES_URL` defaults to `http://127.0.0.1:8642`, the connector defaults to `127.0.0.1:8643`, and state defaults to `~/.config/apollo/connector.json`. The CLI creates a local admin credential at `~/.config/apollo/admin-secret`, so normal pairing commands do not require another environment variable. Both files use mode `0600` in a `0700` directory. `APOLLO_ADMIN_SECRET` remains available as an override. The Hermes API key never appears in pairing output or is accepted from a mobile caller.

The public descriptor is `/.well-known/apollo/agent`. Exchange a one-time token at `POST /v1/pair/exchange` with `{ "token": "...", "device_name": "..." }`. The returned bearer token authorizes the documented Hermes HTTP/SSE routes listed in `index.mjs` and the shared inbox API; WebSockets, arbitrary proxying, and artifact upload/download are intentionally not exposed yet.

`pair --tailscale` is the only command that invokes the Tailscale CLI. It reads `tailscale status --json`, configures `tailscale serve --bg --https=<port> http://127.0.0.1:<connector-port>`, and prints a scannable QR code plus the pasteable fallback link.

Tailscale Serve uses HTTPS port `8443` by default, leaving `443` available for t3code. The mobile endpoint is `https://<machine>.<tailnet>.ts.net:8443`. Override it with `pair --tailscale --tailscale-serve-port PORT`. When moving from an older pairing on port 443, run `node connector/cli.mjs pair --tailscale` and pair the phone again using the new link.

## Thread titles

New mobile threads can request a short title at the device-authenticated `POST /v1/apollo/thread-title` endpoint with `{ "input": "first message" }`. The connector runs the host's authenticated `codex exec` with `gpt-5.6-luna`, low reasoning, a temporary working directory, read-only sandbox and an ephemeral session. User configuration is ignored. The mobile client saves the result through Hermes's session PATCH endpoint.

Codex is optional. Missing login, an unavailable Luna model, a 30-second timeout or a busy title request returns a null title and leaves the first-message title in place. Only one title generation runs at a time. The host must have a recent Codex CLI on PATH; no OpenAI credential is sent to the phone.

### Message attachments

Paired devices can `POST /v1/apollo/attachments` with JSON `{ "name": "notes.txt", "mimeType": "text/plain", "data": "<base64 bytes>" }`. The response contains `attachment: { id, name, mimeType, size, path }`. Each upload is limited to 10 MiB. Names are sanitized and stored under a unique directory, with directory mode 0700 and file mode 0600, in `attachments/` beside the connector state file. Uploads remain there for later thread history and agent access; there is no automatic expiry.

`GET /v1/apollo/attachments/:id` returns the original bytes and requires an active device token, as does uploading. Raster images are served inline; other files are downloads. Responses prohibit caching. All paired owner devices share access to these attachments, just as they share Hermes sessions.

The mobile app includes saved attachment paths and metadata in the Runs API input. Hermes must run on the same machine and be able to read these files; image understanding requires its image-reading tool. Message attachments are not uploaded to a public bucket. Existing connectors must be updated before mobile attachment sends work.

Paired devices read `GET /v1/inbox` and update `PATCH /v1/inbox` with `{ "settled": { "session-id": 123 } }`. Timestamps are session activity times in seconds; `null` explicitly reopens a thread. The connector saves this ledger in its existing state file, shared by all paired devices. Optional `"importOnly": true` fills missing entries without overriding existing timestamps or reopen markers. Update/restart the connector and update the app to enable this; opening the updated app on an existing device migrates its local settled threads. Other devices pick up changes when connecting or returning to the foreground.

# Push notifications

Set `APOLLO_EXPO_PUSH_URL=https://exp.host/--/api/v2/push/send` on the connector host to enable push delivery. If the Expo project uses push access-token security, also set `APOLLO_EXPO_ACCESS_TOKEN`.

Paired devices manage their own registration at `GET|PUT|DELETE /v1/apollo/notifications`. The connector stores the Expo push token in its mode-0600 state file and never returns it from the device admin API. It polls only runs accepted while at least one device is registered. Completion and failure notifications contain agent, session, and run IDs. Approval notifications open Apollo for review and do not expose an approval action.

# Cloud inbox

The connector can route Hermes approvals through the Apollo cloud inbox ([docs/cloud-inbox.md](../docs/cloud-inbox.md)). It needs the Worker URL and a `connector`-role token:

```sh
node connector/cli.mjs cloud set --url https://inbox.example.workers.dev --token-file /path/to/connector-token
node connector/cli.mjs cloud status
```

`cloud set` writes `cloud.json` (mode 0600) beside the state file; override the path with `APOLLO_CLOUD_FILE`. `APOLLO_CLOUD_URL` and `APOLLO_CLOUD_TOKEN` override the file. The connector reads it at startup, so restart after changing it. `cloud status` never prints the token.

When configured:

- Pair exchange mints a cloud `device` token named after the device id and returns `cloud: { url, token }`. Already paired phones call the device-authenticated `POST /v1/apollo/cloud-token` for a fresh one. A cloud failure never fails pairing. Revoking a device deletes its cloud token.
- A run waiting for approval becomes a `hermes` approval card keyed `<runId>:<requestId>` instead of a direct approval push, and runs are watched even when no device registered for connector push. The connector polls `GET /v1/events` while any card is open, answers Hermes with `once` for approve and `deny` for reject, and resolves cards answered in the app thread. Open cards and the event cursor live in the state file.
- Completion and failure pushes still go directly through Expo.

Without the config, nothing changes.
