# Hermes mobile connection and pairing research

Research date: 2026-09-04

Sources are limited to Hermes Agent's official documentation and source, T3 Code's official repository, Tailscale's documentation, and Expo SDK 57 documentation. The inspected revisions were Hermes Agent `63279301bcbdc185c1b07b98a9312eb0c862f26d` and T3 Code `f1e90e388b86fe4b007a55c0e685a1fa878115e6`.

## Recommendation

This is a good product direction. T3 Code is the right reference for connection lifecycle and pairing UX, but copying its mobile app wholesale would bring along a large orchestration model that does not fit Hermes. Copy the boundaries instead:

- The phone knows about one or more stable agent environments.
- Connection transport, authentication, and agent protocol remain separate.
- Tailscale supplies reachability. It is an endpoint provider, not a special environment type.
- Pairing uses a short-lived bootstrap credential, then stores a revocable device credential.
- A connection supervisor owns reconnects, network changes, and visible error states.

Hermes already provides enough HTTP API for a useful first release. The missing piece is a small server-side Ekho connector that makes setup and device authentication safe. It should sit next to Hermes, not become a second agent backend.

## Use Hermes HTTP and SSE, not the dashboard WebSocket

Hermes documents three integrations. ACP is JSON-RPC over stdio, the TUI gateway is JSON-RPC over stdio or WebSocket, and the API server is HTTP plus Server-Sent Events. The API server is the stable fit for a language-agnostic mobile client ([Hermes programmatic integration](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/website/docs/developer-guide/programmatic-integration.md#L9-L15)).

The HTTP API already covers the core mobile product:

- persisted sessions and message history under `/api/sessions/*`;
- async runs through `POST /v1/runs`;
- run status and structured SSE events;
- stop, steer, and approval response endpoints;
- model, skill, toolset, and capability discovery.

The [Runs API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server#runs-api-streaming-friendly-alternative) is the best turn transport. The client receives a `run_id`, can detach and poll status, and can subscribe to tool, text, lifecycle, and subagent events. Send a unique `Idempotency-Key` when starting a run so a mobile retry cannot start the same work twice. Hermes retains idempotency records across restarts and rejects reuse with a different payload ([source](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/website/docs/user-guide/features/api-server.md#L430-L451)).

Persist the active `run_id` locally. Hermes discards an unconsumed event buffer after five minutes, although the run remains available through status polling and control endpoints ([source](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/website/docs/user-guide/features/api-server.md#L472-L492)). On reconnect, fetch run status and session messages, then reopen the event stream if it is still available. Do not make an uninterrupted stream the source of truth.

Do not connect the app to the dashboard's `/api/ws`. Hermes calls that an internal loopback bridge for its embedded TUI and says there is no general remote-attach mode. The API server intentionally does not expose that channel ([Hermes TUI docs](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/website/docs/user-guide/tui.md#L282-L292)). The TUI gateway exposes more controls, but it would couple Ekho to a broader, more volatile protocol before the basic mobile experience needs them.

## The auth gap is real

Hermes requires one `API_SERVER_KEY`, passed as a bearer token. That key grants the full Hermes toolset, including terminal access ([API server security warning](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/website/docs/user-guide/features/api-server.md#L611-L657)). It is a server credential, not a pairing credential. Sharing it by QR would make setup easy but would leave every phone holding the same unscoped secret with no per-device revocation.

There is also an approval inconsistency worth testing before the mobile UI depends on it. The Runs API documents `approval.request`, a `waiting_for_approval` state, and `POST /v1/runs/{id}/approval`; the implementation registers those events ([runs source](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/gateway/platforms/api_server_runs.py#L720-L779)). However, the current approval guard classifies `api_server` as unattended and defaults `approvals.unattended_mode` to deny ([approval source](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/tools/approval.py#L265-L294), [decision branch](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/tools/approval.py#L3825-L3890)). Verify an actual dangerous-command run against the exact Hermes version before designing around interactive approval. This may need a small Hermes fix or clarification upstream.

For a private prototype, a scanned URL containing the Hermes key is acceptable only if it is labeled as an owner credential, stored in secure storage, never logged, and easy to forget locally. It should not be the public pairing design.

## The small connector Hermes needs

The publishable setup should add a narrow Ekho connector on the Hermes host. It owns identity and access, then forwards authenticated requests to the loopback-only Hermes API using the root `API_SERVER_KEY` that never leaves the machine.

Minimum responsibilities:

1. Publish an unauthenticated descriptor such as `/.well-known/ekho/agent` with a stable agent ID, label, connector version, Hermes capabilities, and supported auth methods.
2. Mint a high-entropy, single-use pairing token with a short TTL. The setup command prints a URL and QR code.
3. Exchange the pairing token for a random per-device session token. Store only a hash server-side.
4. Keep device name, creation time, last use, scopes, and revocation state.
5. Authenticate every proxied Hermes request, strip caller-supplied upstream auth headers, and inject the local Hermes key.
6. Expose list and revoke operations in the setup CLI. Start with `chat`, `read`, `run`, and `approve` scopes, or even a single owner scope if narrower enforcement would be mostly pretend in version one.

This copies T3 Code's best idea. T3 issues a one-time owner token, exchanges it for a device session, and stops reusing the bootstrap secret ([T3 remote access](https://github.com/pingdotgg/t3code/blob/f1e90e388b86fe4b007a55c0e685a1fa878115e6/docs/user/remote-access.md#L205-L218)). Its client fetches an environment descriptor, exchanges the credential at `/oauth/token`, and saves the resulting access token ([T3 onboarding source](https://github.com/pingdotgg/t3code/blob/f1e90e388b86fe4b007a55c0e685a1fa878115e6/packages/client-runtime/src/connection/onboarding.ts#L76-L117)).

A pairing URL can use this shape:

```text
ekho://pair?host=https%3A%2F%2Fagent-name.tailnet.ts.net#token=ONE_TIME_TOKEN
```

Keep the token in the fragment. T3 does the same so normal HTTP requests do not send it to the host ([pairing source](https://github.com/pingdotgg/t3code/blob/f1e90e388b86fe4b007a55c0e685a1fa878115e6/apps/mobile/src/features/connection/pairing.ts#L30-L43)). QR should be the primary path, with host and code entry as recovery. Normalize manual codes for case, whitespace, and display separators before exchange.

Show the discovered agent label and hostname before completing an externally opened deep link. T3 deliberately disables production auto-connect from route parameters because an attacker can choose the host and token ([mobile source](https://github.com/pingdotgg/t3code/blob/f1e90e388b86fe4b007a55c0e685a1fa878115e6/apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx#L27-L41)).

## Tailscale design

Run Hermes and the connector on loopback. Publish only the connector with Tailscale Serve:

```text
Hermes API 127.0.0.1:8642
        ^
Ekho connector 127.0.0.1:<port>
        ^
Tailscale Serve HTTPS
        ^
Ekho mobile app
```

Tailscale Serve routes tailnet traffic to a local service over an automatically provisioned HTTPS endpoint. Tailnet access rules still apply ([Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)). MagicDNS supplies the stable `machine.tailnet.ts.net` name, and HTTPS requires the fully qualified name rather than a bare hostname ([MagicDNS](https://tailscale.com/docs/features/magicdns), [HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates)).

Keep Tailscale out of the core environment type. T3 treats it as an endpoint provider; the same bearer-paired environment model works for LAN, Tailscale, other HTTPS tunnels, and relay connections ([T3 remote architecture](https://github.com/pingdotgg/t3code/blob/f1e90e388b86fe4b007a55c0e685a1fa878115e6/docs/internals/remote.md#L44-L70)). Ekho should save an agent plus one or more endpoints and remember the last successful route.

Tailscale Serve adds identity headers and removes spoofed incoming copies. Tailscale recommends that a backend trusting them listen only on localhost ([identity headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers)). The connector can record the tailnet login as pairing context, but device tokens should remain the application authentication layer. This keeps the model usable through non-Tailscale HTTPS later. Never use Funnel by accident. Serve stays private to the tailnet; Funnel is public.

The setup helper should do what `t3 pair --tailscale` does: inspect Tailscale status, configure Serve, probe the published descriptor, mint a short-lived token, and print the exact reachable URL plus QR. T3's implementation reads `tailscale status --json`, builds the MagicDNS HTTPS URL, and configures `tailscale serve --bg --https=<port>` ([Tailscale helper source](https://github.com/pingdotgg/t3code/blob/f1e90e388b86fe4b007a55c0e685a1fa878115e6/packages/tailscale/src/tailscale.ts#L215-L358)).

## Mobile architecture to borrow

Keep the app smaller than T3 Code. A sensible first cut has four deep modules:

- `AgentCatalog`: persisted agents, endpoints, labels, and non-secret metadata.
- `CredentialStore`: per-agent device tokens backed by Expo SecureStore.
- `HermesClient`: typed request and event decoding for the exact endpoints Ekho uses.
- `ConnectionSupervisor`: online state, active run recovery, explicit retry, and bounded backoff.

T3 keeps its connection protocol and lifecycle in a shared client runtime, with the React Native screens acting as adapters. Its supervisor uses staged connection states and bounded retry delays of 3, 4, 8, and 16 seconds ([source](https://github.com/pingdotgg/t3code/blob/f1e90e388b86fe4b007a55c0e685a1fa878115e6/packages/client-runtime/src/connection/supervisor.ts#L30-L35)). That separation is worth copying. Its Effect-based machinery is not required for Ekho. Plain TypeScript state machines plus focused tests can preserve the same boundaries.

Store only credentials in SecureStore. Expo SDK 57 stores values in Android Keystore-backed encrypted preferences and iOS Keychain, but warns about size limits, platform-specific uninstall behavior, and treating it as the only source of truth for critical data ([Expo SecureStore](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/)). Put messages and agent metadata in SQLite or normal app storage. T3 also wraps `expo-secure-store` behind a tiny platform storage interface ([source](https://github.com/pingdotgg/t3code/blob/f1e90e388b86fe4b007a55c0e685a1fa878115e6/apps/mobile/src/persistence/mobile-secure-storage.ts#L1-L51)).

Expo Camera 57 supports QR-only barcode scanning through `CameraView` and `barcodeScannerSettings` ([Expo Camera](https://docs.expo.dev/versions/v57.0.0/sdk/camera/)). Ask for camera permission only when the user opens Scan. Always keep paste and manual entry available.

## Suggested MVP boundary

Ship this first:

- add, scan, edit, forget, and reconnect to one or more agents;
- Tailscale Serve HTTPS plus custom HTTPS endpoints;
- session list, session history, new session, and one active run per agent;
- structured text and tool-progress timeline;
- stop, retry, and foreground reconnect reconciliation;
- secure per-device credentials and server-side revocation;
- capability-driven UI based on `/v1/capabilities` instead of version checks.

Defer terminal emulation, files, diffs, browser control, voice, notifications, relay infrastructure, LAN discovery, and a custom TUI gateway client. Those are good later features, but none proves the central product loop.

The first integration test should exercise the whole boundary on real devices: scan a one-time QR, exchange it, restart the app, start a run with an idempotency key, drop the network during SSE, restore Tailscale, reconcile through run status and session history, then revoke the device and confirm the next request fails.
