# Apollo on Exact (prototype, throwaway)

Question: should Apollo be rewritten on Expo's Exact? This spike rebuilds the thread list and
session screen (live transcript, composer, Stop, approvals) against Apollo's real connector.

## Run it

```sh
node tools/fixture.mjs            # Apollo's connector on :19111 over a fake Hermes on :19112
tools/sync-apollo.sh              # copy Apollo's transcript modules in (Exact won't import ../../src)
bun exact.mjs ios --sim <udid>    # or: bun exact.mjs mac --run
```

Needs `~/code/exact` set up with Bun 1.4.2, and `~/.swiftly/bin` off PATH (its Swift 6.3.2
crashes on the Xcode 27.2 SDK). Fixture inputs: `approval`, `hold`, `storm` (2,000 deltas).

## Verdict

Worth pursuing. The rewrite is mostly a view rewrite.

- Worked on the iOS Simulator and macOS: history, streaming, Stop, Approve, markdown, a native
  nav bar, and the composer riding the keyboard.
- `app.ts` reuses Apollo's `createTranscriptProjector` and `run-state` unchanged (copied in).
- Exact's SSE reader drops events under load: the storm kept 785 of 2,000 deltas. Reading the
  same stream as bytes kept 2,000 of 2,000. A real port needs the connector to relabel
  `/v1/runs/:id/events` as `application/octet-stream` when asked (a few lines).
- Gaps seen: tables render as pipe source, code blocks are unstyled, and the transcript did
  not scroll to a new turn after a send.
- Not tested: physical device, web (the connector has no CORS), push, Keychain, App Store.
