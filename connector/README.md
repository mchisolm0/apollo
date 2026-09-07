# Ekho connector

The connector is a small Node 22+ process that keeps Hermes on loopback while exposing a paired, revocable mobile API over an HTTPS transport such as Tailscale Serve.

```sh
HERMES_API_KEY=... node connector/cli.mjs serve
node connector/cli.mjs pair --tailscale
node connector/cli.mjs devices
node connector/cli.mjs revoke DEVICE_ID
```

`HERMES_URL` defaults to `http://127.0.0.1:8642`, the connector defaults to `127.0.0.1:8643`, and state defaults to `~/.config/ekho/connector.json`. The CLI creates a local admin credential at `~/.config/ekho/admin-secret`, so normal pairing commands do not require another environment variable. Both files use mode `0600` in a `0700` directory. `EKHO_ADMIN_SECRET` remains available as an override. The Hermes API key never appears in pairing output or is accepted from a mobile caller.

The public descriptor is `/.well-known/ekho/agent`. Exchange a one-time token at `POST /v1/pair/exchange` with `{ "token": "...", "device_name": "..." }`. The returned bearer token authorizes only the documented Hermes HTTP/SSE routes listed in `index.mjs`; WebSockets, arbitrary proxying, and artifact upload/download are intentionally not exposed yet.

`pair --tailscale` is the only command that invokes the Tailscale CLI. It reads `tailscale status --json`, configures `tailscale serve --bg --https=<port> http://127.0.0.1:<connector-port>`, and prints a scannable QR code plus the pasteable fallback link.

Tailscale Serve uses HTTPS port `8443` by default, leaving `443` available for t3code. The mobile endpoint is `https://<machine>.<tailnet>.ts.net:8443`. Override it with `pair --tailscale --tailscale-serve-port PORT`. When moving from an older pairing on port 443, run `node connector/cli.mjs pair --tailscale` and pair the phone again using the new link.
