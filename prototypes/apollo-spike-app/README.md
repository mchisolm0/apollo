# Apollo on Exact (prototype)

Question: should Apollo be rewritten on Expo's Exact? This client pairs with an Apollo connector,
lists Hermes threads, starts new ones, and follows runs live with Stop and approvals.
`app.ts` reuses Apollo's transcript projector and run-state code unchanged.

## On the phone

The iPhone build is signed with the team's wildcard development profile and installed from the
mini (`bun exact.mjs share` uses AppDrop, which wants an Apple ID sign-in and a VPN; skip it):

```sh
DEVELOPMENT_TEAM=69V3522FCX EXACT_PROFILE=<iOS Team Provisioning Profile: *> \
  bun exact.mjs ios --device --phone <udid> --release --no-install --json
AGENT_DEVICE_MINI_DAILY_DRIVER=1 agent-device-mini install com.matthewchisolm.apollo.exactspike "<path>.app" --udid <udid>
```

It pairs with the live connector on the mini, like Apollo itself: `node connector/cli.mjs pair
--tailscale --ttl 900` in `~/code/apollo` prints a one-use link. Its inbox, cards and settle state
are the real ones, so settling here settles in Apollo too.

## Locally

```sh
node tools/fixture.mjs            # connector on :19111 over a fake Hermes; prints a pairing link
tools/sync-apollo.sh              # copy Apollo's transcript modules in (Exact won't import ../../src)
bun exact.mjs ios --sim <udid>    # or: bun exact.mjs mac --run
```

Needs `~/code/exact` set up with Bun 1.4.2, and `~/.swiftly/bin` off PATH (its Swift 6.3.2
crashes on the Xcode 27.2 SDK). Fixture inputs: `approval`, `hold`, `storm` (2,000 deltas).

## Findings

- Exact's SSE reader coalesces events under load: a storm of 2,000 deltas kept 785. The
  connector now serves `/v1/runs/:id/events` as bytes when asked (`Accept:
  application/octet-stream`), which Exact reads losslessly: 2,000 of 2,000.
- Exact won't import files outside the app folder or through symlinks, so a real port would
  move the relay modules into a shared package.
- Exact's native list rows (`list appearance="auto"`) blank a long-pressed row until its menu
  lifts it, so the inbox uses a plain list and paints its own swipe action.
- Not built: push notifications, snooze, search, attachments and sharing, voice, model and skill
  pickers, settings, iPad split view, code highlighting.
