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

It pairs with a second connector on the mini, separate from the live one:

| | |
|---|---|
| Connector | `~/apollo-exact/connector` on the mini, LaunchAgent `com.matthewchisolm.apollo-exact-connector` |
| Port | `127.0.0.1:8653`, served at `https://mini.potoroo-tet.ts.net:8453` (tailnet only) |
| State | `~/.config/apollo-exact/` (no cloud inbox, no push) |
| Logs | `~/Library/Logs/apollo/com.matthewchisolm.apollo-exact-connector.*.log` |
| Pairing link | `ssh mini ~/apollo-exact/pair.sh` (one use, 15 minutes) |

Remove it with `launchctl bootout gui/$(id -u)/com.matthewchisolm.apollo-exact-connector`,
`tailscale serve --https=8453 off`, and deleting the two folders above.

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
- Not built: attachments, model and skill pickers, voice, notifications, the cloud inbox,
  iPad split view, code highlighting.
