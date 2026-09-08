# Ekho connector

The connector is a small Node 22+ process that keeps Hermes on loopback while exposing a paired, revocable mobile API over an HTTPS transport such as Tailscale Serve.

```sh
HERMES_API_KEY=... node connector/cli.mjs serve
node connector/cli.mjs pair --tailscale
node connector/cli.mjs devices
node connector/cli.mjs revoke DEVICE_ID
```

`HERMES_URL` defaults to `http://127.0.0.1:8642`, the connector defaults to `127.0.0.1:8643`, and state defaults to `~/.config/ekho/connector.json`. The CLI creates a local admin credential at `~/.config/ekho/admin-secret`, so normal pairing commands do not require another environment variable. Both files use mode `0600` in a `0700` directory. `EKHO_ADMIN_SECRET` remains available as an override. The Hermes API key never appears in pairing output or is accepted from a mobile caller.

The public descriptor is `/.well-known/ekho/agent`. Exchange a one-time token at `POST /v1/pair/exchange` with `{ "token": "...", "device_name": "..." }`. The returned bearer token authorizes the documented Hermes HTTP/SSE routes listed in `index.mjs` and the shared inbox API; WebSockets, arbitrary proxying, and artifact upload/download are intentionally not exposed yet.

`pair --tailscale` is the only command that invokes the Tailscale CLI. It reads `tailscale status --json`, configures `tailscale serve --bg --https=<port> http://127.0.0.1:<connector-port>`, and prints a scannable QR code plus the pasteable fallback link.

Tailscale Serve uses HTTPS port `8443` by default, leaving `443` available for t3code. The mobile endpoint is `https://<machine>.<tailnet>.ts.net:8443`. Override it with `pair --tailscale --tailscale-serve-port PORT`. When moving from an older pairing on port 443, run `node connector/cli.mjs pair --tailscale` and pair the phone again using the new link.

## Thread titles

New mobile threads can request a short title at the device-authenticated `POST /v1/ekho/thread-title` endpoint with `{ "input": "first message" }`. The connector runs the host's authenticated `codex exec` with `gpt-5.6-luna`, low reasoning, a temporary working directory, read-only sandbox and an ephemeral session. User configuration is ignored. The mobile client saves the result through Hermes's session PATCH endpoint.

Codex is optional. Missing login, an unavailable Luna model, a 30-second timeout or a busy title request returns a null title and leaves the first-message title in place. Only one title generation runs at a time. The host must have a recent Codex CLI on PATH; no OpenAI credential is sent to the phone.

### Message attachments

Paired devices can `POST /v1/ekho/attachments` with JSON `{ "name": "notes.txt", "mimeType": "text/plain", "data": "<base64 bytes>" }`. The response contains `attachment: { id, name, mimeType, size, path }`. Each upload is limited to 10 MiB. Names are sanitized and stored under a unique directory, with directory mode 0700 and file mode 0600, in `attachments/` beside the connector state file. Uploads remain there for later thread history and agent access; there is no automatic expiry.

`GET /v1/ekho/attachments/:id` returns the original bytes and requires an active device token, as does uploading. Raster images are served inline; other files are downloads. Responses prohibit caching. All paired owner devices share access to these attachments, just as they share Hermes sessions.

The mobile app includes saved attachment paths and metadata in the Runs API input. Hermes must run on the same machine and be able to read these files; image understanding requires its image-reading tool. Message attachments are not uploaded to a public bucket. Existing connectors must be updated before mobile attachment sends work.

Paired devices read `GET /v1/inbox` and update `PATCH /v1/inbox` with `{ "settled": { "session-id": 123 } }`. Timestamps are session activity times in seconds; `null` explicitly reopens a thread. The connector saves this ledger in its existing state file, shared by all paired devices. Optional `"importOnly": true` fills missing entries without overriding existing timestamps or reopen markers. Update/restart the connector and update the app to enable this; opening the updated app on an existing device migrates its local settled threads. Other devices pick up changes when connecting or returning to the foreground.
