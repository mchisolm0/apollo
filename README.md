# Ekho

Ekho is a private mobile client for [Hermes Agent](https://hermes-agent.nousresearch.com/docs/). It pairs each phone with its own revocable credential, keeps the Hermes root API key on the host, and connects over Tailscale Serve or another private HTTPS route.

## What works

- QR, deep-link, and paste pairing with identity confirmation
- Multiple paired agents and per-device revocation
- Hermes sessions, history, runs, SSE progress, stop, and approvals
- Foreground reconciliation, explicit retry, and active-run recovery
- SecureStore credentials and AsyncStorage agent metadata
- LegendList for session, agent, and run timelines

## Run the app

Requirements: Node 22+, pnpm, Xcode for iOS, or Android Studio for Android.

```sh
pnpm install
pnpm ios
```

Use `pnpm android` for Android. Camera and SecureStore are native dependencies, so Expo Go is not the supported development path.

For preview and production builds, versioning, and OTA publishing commands, see [Builds, versions, and OTA updates](docs/development/eas-updates.md).

## Connect Hermes

Enable Hermes on loopback in `~/.hermes/.env`:

```sh
API_SERVER_ENABLED=true
API_SERVER_KEY=replace-with-a-long-random-secret
```

Start Hermes:

```sh
hermes gateway
```

To start the connector automatically when you log in and restart it after a
crash, run this once from the repository. Hermes remains managed by its
existing gateway process:

```sh
pnpm install:macos-services
```

This installs one per-user macOS LaunchAgent for Ekho. It loads
`~/.hermes/.env`, so the connector uses the same `API_SERVER_KEY` as Hermes.
Logs are written to `~/Library/Logs/ekho/`.

In this repository, start the connector with the same key:

```sh
HERMES_API_KEY=replace-with-a-long-random-secret node connector/cli.mjs serve
```

The connector accepts only a loopback Hermes URL and never returns that root key to the app. Its local admin credential is created automatically in `~/.config/ekho/admin-secret`.

With Tailscale installed, connected, and MagicDNS enabled, run in another terminal:

```sh
node connector/cli.mjs pair --tailscale --name "My phone"
```

Scan the printed QR code in Ekho. The fallback link can be pasted into the app or opened directly on the phone. The pairing token expires after five minutes and works once.

Without Tailscale, pass an HTTPS endpoint that already routes privately to the connector:

```sh
node connector/cli.mjs pair --public-base-url https://agent.example.com
```

Do not expose the connector with Tailscale Funnel. Tailscale Serve stays private to the tailnet.

## Manage devices

```sh
node connector/cli.mjs devices
node connector/cli.mjs revoke DEVICE_ID
```

For connector options and the HTTP contract, see [connector/README.md](connector/README.md). The architectural and security rationale is in [docs/research/hermes-mobile-architecture.md](docs/research/hermes-mobile-architecture.md).

## Verify

```sh
pnpm typecheck
pnpm lint
pnpm test:connector
```

Integrated mobile verification follows [.agents/skills/test-ekho-mobile/SKILL.md](.agents/skills/test-ekho-mobile/SKILL.md).
