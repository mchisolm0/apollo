---
name: test-ekho-mobile
description: Verify user-visible Ekho mobile changes in the real Expo app after implementation. Use for integrated UI, pairing, connection, persistence, or recovery checks, not unit tests or backend-only work.
---

# Test Ekho mobile

Run one focused pass against the affected flow with `agent-device`. Prefer a running iOS simulator unless the change is Android-specific. QR camera scanning and real Tailscale reachability require a physical device and must not be claimed from simulator evidence.

## Establish the launch path

Inspect `package.json`, Expo config, running Metro processes, installed apps, and the changed files before launching.

- Reuse a healthy Metro process only when it belongs to this worktree and uses the expected app variant and port.
- Reuse an installed development client for JavaScript, TypeScript, and asset-only changes when its native compatibility is credible.
- Native dependencies, config plugins, entitlements, generated projects, or uncertain compatibility require a matching rebuild. Do not silently use Expo Go as evidence for a development-client build.
- If a required build or backend is missing and creating it is outside the active request, stop and report the prerequisite.

Use one explicit `agent-device` session for the entire pass. Open the app first, then follow the snapshot, act, settle, verify loop. Use accessibility refs or selectors before coordinates. Close only processes and devices started by this pass.

## Preserve state

Keep the installed app's state unless the changed behavior requires first-run pairing or credential removal. Never inject SecureStore, SQLite, or app state to bypass the real flow. If clearing state is necessary, say what will be removed before doing it.

Do not print or capture pairing codes, device tokens, Hermes API keys, Tailscale identity headers, or secret-bearing deep links. Redact screenshots that accidentally contain them and do not publish those artifacts.

## Pairing and connection checks

Use the smallest real setup that exercises the change:

1. Confirm the app loaded this worktree's bundle.
2. Pair through the changed entry path. On a simulator, use the app's manual paste or deep-link recovery path. Test QR scanning only on a physical device.
3. Confirm the discovered agent label and hostname appear before the credential exchange.
4. Force-close and reopen the app. Confirm the saved agent returns and reconnects without the one-time pairing code.
5. Start one run, record its visible `run_id` only when the UI exposes a non-secret shortened form, and observe text plus tool-progress updates.
6. Interrupt connectivity. Restore it and confirm the app reconciles status and transcript without duplicating the run.
7. Revoke or forget the device through the real control path when that behavior changed. Confirm the next request fails with a clear recovery action.

Use a local development connector and non-production Hermes instance unless the user explicitly authorizes another target. Never change Tailscale Serve, Funnel, ACLs, production agents, or daily-driver Hermes processes as an incidental test step. Name any external environment before touching it.

## Visual checks

Verify the affected states on one representative device:

- true black background and white primary text;
- no clipped transcript, composer, keyboard, safe-area, or system-bar content;
- connection state remains legible without relying on color alone;
- approval and destructive actions have clear, distinct labels;
- Dynamic Type and VoiceOver labels remain usable for the changed controls;
- empty, loading, offline, expired-pairing, and revoked-device states provide a next action when in scope.

Capture screenshots for each meaningful state. Record a short video only when motion, streaming, interruption, or reconnection timing is under test. Store evidence outside the worktree.

## Report

Return pass, fail, or skipped for each requested behavior. State what was observed, the device and build used, backend and network caveats, and artifact paths. Never infer a pass from logs or source when the flow was not observed.
