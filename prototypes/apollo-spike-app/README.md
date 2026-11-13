# Apollo on Exact (prototype)

Question: should Apollo be rewritten on Expo's Exact? This client pairs with an Apollo connector,
lists Hermes threads, starts new ones, and follows runs live with Stop and approvals.
`app.ts` reuses Apollo's transcript projector and run-state code unchanged.

The inbox puts what waits on you first, answerable from the row (a thread's command to approve, a
card to answer), then one row each for Feedback (player reports) and Routines, then the threads.
Search and New Thread sit at the bottom. In a thread an approval shows where it was asked and is
pinned above the composer; More holds the wider tiers. As in Apollo, only runs this phone started
can ask from the inbox. Feedback lists reports without Apollo's filters or reply thread yet.

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
crashes on the Xcode 27.2 SDK). Fixture inputs: `approval`, `hold`, `refuse` (503), `storm` (2,000 deltas).

## Findings

- Exact's SSE reader coalesces events under load: a storm of 2,000 deltas kept 785. The
  connector now serves `/v1/runs/:id/events` as bytes when asked (`Accept:
  application/octet-stream`), which Exact reads losslessly: 2,000 of 2,000.
- Exact won't import files outside the app folder or through symlinks, so a real port would
  move the relay modules into a shared package.
- Exact's native list rows (`list appearance="auto"`) blank a long-pressed row until its menu
  lifts it ([expo/exact#419](https://github.com/expo/exact/issues/419), with a fix). UIKit's swipe
  actions press a button but skip its `popovertarget`, so Snooze opens its menu with `showPopover`.
- Exact's `<audio-waveform>` draws speech a point high and, on Apple, in jumps
  ([expo/exact#420](https://github.com/expo/exact/issues/420), with what worked for us).
- Exact's speech recognition takes a `@exact/media-capture` microphone track, not
  `microphone=true` (not built on Apple). The simulator has no on-device English model, so
  dictation answers `language-not-supported` there; it needs a phone.
- `navigationSplit` splits on the web and the Mac only; Exact's iPad host doesn't split yet.
  Exact's Markdown draws code blocks without syntax colours.
- Push and sharing on the phone need an explicit App ID (Push, and the App Group
  `group.com.matthewchisolm.apollo.exactspike`) instead of the wildcard profile, plus an APNs key
  for that bundle id in EAS so the cloud and connector can send through Expo. Sharing works on the
  simulator.
