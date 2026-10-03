---
name: test-ekho-mobile
description: Use AFTER implementing user-visible Apollo (Ekho) mobile changes, when asked for an integrated pass or to verify a change in the real app. Covers UI, theming, settings, pairing, runs, updates, and notifications. Not for unit tests or connector-only changes.
---

# Test Ekho mobile

Run one focused verification pass against the real development app on an iOS
simulator, driven through `agent-device`. Use Android only when Android is the
affected surface or explicitly requested.

## Scope

1. Confirm what changed and the expected behavior. If nothing user-visible
   changed, say so and stop.
2. Exercise only the affected flow on one representative device unless the
   change concerns platform, OS version, or screen size.
3. If a prerequisite is missing, report it rather than working around it. Never
   claim verification you did not observe.

## Identity

- App: `Ekho Dev`, bundle `com.matthewchisolm.ekho.dev`, scheme `ekho-dev`
- Metro: `pnpm start:dev` (development variant, dev client, port `8085`)
- Simulator: a dedicated `Apollo QA` iPhone simulator. Never install into or
  reset simulators that belong to other projects (for example `Scryve *`).
- Repository checks that must pass before a runtime pass:
  `pnpm typecheck && pnpm lint && pnpm test:mobile && pnpm test:connector`

## Choose the lightest valid launch path

- JavaScript, TypeScript, or asset-only changes: reuse the installed
  development client and start Metro. Do not rebuild native code to load a new
  bundle.
- Native source, native dependencies, config plugins, `app.json` /
  `app.config.ts` native fields, or a missing dev client: build a simulator
  client locally with `pnpm ios:dev --device "Apollo QA"` from the worktree
  under test. `ios/` and `android/` are generated and gitignored; never commit
  them.
- Never start an EAS build, `eas update`, or submit during a verification pass.
  Those publish to shared channels and need separate approval.

Bundle presence proves the variant, not native compatibility. If you cannot
establish that the installed dev client was built from the current native
inputs (dependencies, plugins, native config), rebuild the simulator client
rather than guessing.

## Setup

1. `agent-device devices --platform ios`. Boot `Apollo QA` if it is not
   running. If it does not exist, create it with
   `xcrun simctl create "Apollo QA" "iPhone 17 Pro"` (or the newest available
   iPhone type).
2. Metro health check before starting anything: inspect the process on port
   `8085` and its `/status`. Reuse it only when it is healthy, belongs to the
   worktree under test, and runs `EKHO_APP_VARIANT=development` with
   `--dev-client`. Never kill another worktree's Metro. If 8085 belongs to
   another worktree, stop only a Metro you started, or use a free explicit
   port and open the app against it.
3. Otherwise run `pnpm start:dev` from the worktree root in the background and
   wait for the bundler.
4. Open the app with one stable session for the whole pass:
   `agent-device open com.matthewchisolm.ekho.dev --platform ios --session ekho-mobile-check`.
   Use that same session for every snapshot, action, close, and reopen.

### Parallel worktrees

When several worktrees verify at once, each uses its own simulator (for
example `Apollo QA 2`, cloned from a paired `Apollo QA`) and its own Metro
port. Start Metro with
`EKHO_APP_VARIANT=development npx expo start --dev-client --port <port>` and
point the dev client at it with
`xcrun simctl openurl <udid> "exp+ekho://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<port>"`.
Native rebuilds install only into the worktree's own simulator.

## Agent and backend

The only Hermes on this machine is the user's daily driver. launchd runs it
(`ai.hermes.gateway`) with the connector from `~/code/apollo`
(`com.matthewchisolm.ekho-connector`, `127.0.0.1:8643`).

- Never restart, stop, reconfigure, or redeploy Hermes or the connector. Never
  edit `~/.hermes/*` or `~/.config/ekho/*`. Never run `pair --tailscale` or
  change Tailscale Serve, Funnel, or ACLs.
- The running connector is whatever `~/code/apollo` has checked out, not the
  worktree under test. Connector changes in a PR are not live. Test the app's
  behavior against the live connector, including how it degrades when a new
  route is missing, and report the connector side as skipped.
- If the simulator needs pairing, create a short-lived local pairing without
  printing the secret:
  `node ~/code/apollo/connector/cli.mjs pair --name "Apollo QA simulator" > "$TMPDIR/ekho-pair.txt"`
  then extract the `ekho://pair?...` line into the simulator pasteboard
  (`grep -m1 '^ekho://pair' "$TMPDIR/ekho-pair.txt" | xcrun simctl pbcopy booted`),
  paste it on the app's connect screen, and delete the file. Keep an existing
  pairing whenever it still works.
- Runs: keep prompts tiny and clearly labeled, for example
  `[QA] Reply with OK.` Do not delete, rename, settle, or fork threads the pass
  did not create. Never answer an approval request with `always`.

Do not print or capture pairing tokens, device bearer tokens, Hermes API keys,
admin secrets, or Tailscale identity headers. Redact screenshots that
accidentally contain them and do not publish those artifacts.

## Preserve state

Keep the installed app's state unless the change requires first-run pairing,
credential removal, or a clean install. Never inject SecureStore,
AsyncStorage, or app state to bypass the real flow. If clearing state is
necessary, say what will be removed before doing it.

## Drive with agent-device

Follow the open -> snapshot -i -> act -> re-snapshot/diff -> verify -> close
loop.

- Act on refs or selectors from accessibility snapshots. Fall back to
  screenshot coordinates only for elements the AX tree misses.
- Use `--settle` and wait for the UI rather than fixed sleeps.
- Treat permission dialogs as part of the flow under test unless asked to
  pre-grant them.

## What to validate

- Changed screens render correctly in every relevant state (empty, loading,
  offline, error, populated).
- Theming: switching themes changes every affected surface, including the
  inbox and thread screens, and the choice survives a force-close.
- Dark only: no clipped transcript, composer, keyboard, safe-area, or
  system-bar content, and text stays legible on every theme.
- Connection state is legible without relying on color alone. Approval and
  destructive actions have clear, distinct labels.
- Dynamic Type and VoiceOver labels stay usable for changed controls.
- Persistence: force-close and relaunch mid-flow. Saved agents, drafts, theme,
  and settings must survive.
- Obvious regressions in adjacent screens navigated along the way.

## Evidence

Capture screenshots of each meaningful state. Record a short video only for
motion, streaming, interruption, or timing changes. Save artifacts under
`$TMPDIR/ekho-mobile-check/<branch>/`, never in the worktree, and reference
them by path.

## Verify and clean up

1. Confirm the app loaded this worktree's bundle from the intended Metro port,
   not a stale bundle from another worktree.
2. Capture the relevant final state.
3. Stop only the Metro, simulator, and log processes started by this pass.
4. Leave Hermes, the connector, and existing pairings running.

## Report

Return pass, fail, or skipped for each validated item, with observed versus
expected behavior, the device and build used, artifact paths, and caveats (live
connector older than the PR, no physical device, etc.). Never infer a pass from
logs or source when the flow was not observed.

## Troubleshoot predictable failures

- **Old UI or stale errors:** verify Metro's worktree, variant, and port, then
  reload the bundle.
- **App won't reach Metro:** confirm the installed app is
  `com.matthewchisolm.ekho.dev`. Preview and production builds ignore Metro.
- **Native module missing at runtime:** the dev client predates a native
  change. Rebuild the simulator client.
- **Agent shows offline:** check `curl -s 127.0.0.1:8643/.well-known/ekho/agent`
  without credentials. If the connector is down, report it. Do not restart it.
- **New connector route returns 404:** expected until the user updates the
  running connector. Record as skipped and confirm the app degrades cleanly.
