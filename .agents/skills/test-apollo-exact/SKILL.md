---
name: test-apollo-exact
description: Use AFTER changing Apollo on Exact (prototypes/apollo-spike-app, or a shared src/ module it copies in) to prove the change before a commit or PR. Contract tests against a fake Hermes behind the real connector, then a screenshot drive for anything you can see. Not for the Expo app (test-apollo-mobile) or connector-only changes (node --test connector/*.test.mjs).
---

# Test Apollo on Exact

Three tiers, cheapest first. Stop at the tier that proves the change; say which tiers you ran.

Setup, once per shell (bun from mise, not swiftly's toolchain; the Exact checkout the app builds with):

```sh
cd prototypes/apollo-spike-app
export PATH=$HOME/.local/share/mise/installs/bun/1.4.2/bin:$(echo $PATH | tr ':' '\n' | grep -v swiftly | paste -sd: -)
export EXACT2=/tmp/exact-flash
```

## 1. Contract tests (every change)

```sh
bun exact.mjs contract build app.contract --json --errors-only   # [] : the view compiles and app.ts type-checks
bun exact.mjs test web                                           # app.test.contract: unpaired flows, about 20 s
sh tools/test-paired.sh                                          # tests/*.test.contract on an iOS simulator, about 30 s
```

`test-paired.sh` re-copies the shared modules (`tools/sync-apollo.sh`), starts `tools/fixture.mjs`
unless one is up, and runs the paired tests. Each test pairs with the reusable link
`apollo://pair?host=http%3A%2F%2F127.0.0.1%3A19111#token=fixture`, which resets the fixture's
threads, cards and routines first, so tests never depend on each other. A fixture you started by
hand keeps its old code: restart it after editing `fixture.mjs` or the connector.

Paired tests run on iOS because a thread streams its run (`exactStream`), which the web host only
allows before the data function's first await. Inbox, card and routines tests also pass on web.

Add a paired test for each new flow. The fixture's inputs: a message containing `approval` asks to
run a command with every tier, `approval once only` offers only once and deny, `hold` runs until
stopped or steered, `storm` floods 2,000 deltas. Wait on a run with
`clock until state thread.status == "completed" within 5000`, never real sleeps. Give every new
control a `testId`.

## 2. A drive with screenshots (anything you can see)

Drive the changed screen and look at it, light and dark:

```sh
bun exact.mjs agent ios --storage look --reset-storage \
  "type pair-link apollo://pair?host=http%3A%2F%2F127.0.0.1%3A19111#token=fixture" "tap pair" "clock data" \
  "tap row-spike-session" "clock data" "screenshot .exact/thread.png" "prefer color-scheme dark" "screenshot .exact/thread-dark.png"
```

Run `bun exact.mjs verify ios` before a PR: it runs the tests, checks each end screen in both
appearances and at the largest text size, and plays real touches on the first screen's list.

## 3. By hand (only what the simulator can't show)

Dictation, push notifications, the share sheet, VoiceOver, and the live connector on the mini.
The iPhone 17e is Matthew's daily driver: install there only when he asks for it by name, as
`prototypes/apollo-spike-app/README.md` says. Name what stayed unproven.

The Expo app keeps `test-apollo-mobile` until Exact replaces it.
