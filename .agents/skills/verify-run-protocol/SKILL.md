---
name: verify-run-protocol
description: Use when a change touches how Apollo on Exact, the connector, or the cloud inbox start runs, steer them, or answer Hermes approvals, or edits any file listed under Coverage. Model-checks every order of those steps, including lost replies, timeouts, and answers from several places.
---

# Verify the run protocol

Two small TLA+ models of how a run passes between the phone, the connector,
the cloud inbox, and Hermes. TLC, the TLA+ model checker, tries every order of
their steps within the bounds in `check.sh` and checks each rule in every state.

`Approvals.tla` is one run asking for approvals. The thread screen, a cloud
card answered from any phone, and away mode can all answer, and Hermes can time
a request out:

1. **AnswerMatches.** An answer settles only the request it was given for.
2. **PendingVisible.** Once quiet, every request Hermes waits on is shown on
   the thread screen or has an open card.
3. **CardsCurrent.** Once quiet, the only open card is for the request on the
   run's status.

`Steers.tla` is one thread: created with its first message, steered while it
runs, and opened again after the run ends. Steers can repeat each other's words
or the first message's:

4. **KeepsStarted.** The app never deletes a thread whose run began.
5. **UndeliveredExact.** The reopened thread names each steer Hermes never
   saved exactly once, and no other.

## Run it

```bash
.agents/skills/verify-run-protocol/check.sh             # every run, about 10 seconds
.agents/skills/verify-run-protocol/check.sh blind       # one run, with TLC's full output
```

It needs Java 11 or newer. The first run downloads TLC 1.7.4 into
`~/.cache/apollo` and checks its sha256.

Each `ok` line is a run that went as expected. The app runs (`answers`, `away`,
`steers`) must pass. Each break turns off one thing the code does and must fail
on the rule it names, which proves that rule can still catch a bug:

| Break | Turns off | Must fail |
| --- | --- | --- |
| `blind` | sending `request_id` with every answer | AnswerMatches |
| `stale-cards` | the bridge resolving a card once its request leaves the status | CardsCurrent |
| `delete-start` | `createThread` keeping a thread whose start is uncertain | KeepsStarted |
| `no-reread` | the reopen reading history again after the run's status | UndeliveredExact |
| `any-words` | counting a steer's words against `before` | UndeliveredExact |

## Known gaps

These runs fail on today's code. Each one checks that it still fails, so it
reports `FAIL ... got pass` once the gap is closed. Then move it to the app runs.

| Gap | Fails | What happens |
| --- | --- | --- |
| `two-at-once` | PendingVisible | Two subagents ask at once. Hermes's run status shows only the newest request, the bridge resolves the older card, and `currentApproval` shows only the newest. The older one waits unseen until Hermes times it out and denies it. |
| `late-reply` | UndeliveredExact | A steer's reply lands after the screen read history again, or never lands. The app records it against the wrong count of matching words, so the reopen names a saved steer as undelivered, or misses a dropped one with the same words. Hermes's history has no steer ids, so matching by words is the limit. |

The app runs assume each steer's reply lands before the screen reads history
again (`OnTime`). `late-reply` is the same model without that assumption.

## When it fails

`check.sh <run>` prints the shortest sequence of steps that breaks the rule.
Each step is a named action in the `.tla` file, and each action's comment names
the code it stands for. Read the trace against that code:

- If the code does what the trace says, the change has a real bug. Fix the code.
- If the model does something the code cannot do, the model is wrong. Fix the
  action, and cite the code that rules the step out.

Never weaken a rule or shrink a bound to make a run pass.

## When you change covered code on purpose

Update the matching action so it still describes the code, run `check.sh`, and
commit the model with the code. If the code changed but the model still
describes it, update the date under Coverage instead. Covered code that changed
after the last commit to this folder has not been checked against the model:

```bash
git log --oneline "$(git log -1 --format=%H -- .agents/skills/verify-run-protocol)..HEAD" -- \
  prototypes/apollo-spike-app/app.ts src/lib/run-state.ts \
  connector/index.mjs connector/cloud.mjs connector/away.mjs \
  connector/notifications.mjs cloud/src/inbox.ts
```

## Coverage

Last checked against the covered code on 2026-11-16, and against Hermes at
NousResearch/hermes-agent 40d1e95.

| File | What the models stand for |
| --- | --- |
| `prototypes/apollo-spike-app/app.ts` | `answerApproval`, `steerRun` and its `before` count, `createThread` and `start`, the reopen in `transcript` (`unseen`, the second history read, `undelivered`) |
| `src/lib/run-state.ts` | `currentApproval`, the request the thread screen shows |
| `connector/index.mjs` | `answerApproval`: answers by `request_id`, a 4xx means the request is gone |
| `connector/cloud.mjs` | `createApprovalBridge`: posting, resolving stale cards, answering from card events |
| `connector/away.mjs` | `deny`, by the request on the status |
| `connector/notifications.mjs` | the run monitor: away mode first, then the bridge |
| `cloud/src/inbox.ts` | answering a card resolves it and appends an action event |
| Hermes `gateway/platforms/api_server_runs.py` | the status shows the newest request, answering one returns the run to running, steers only while running |
| Hermes `tools/approval.py` | answering by exact `request_id`, or the oldest without one |
| Hermes `agent/interrupt_control.py` | `pending_steer` on a finished run, steers dropped unnamed on a hard stop |

## Not covered

The Expo app's thread screen, which has its own steer and approval code. Push
notifications and the direct-push fallback when the cloud is down. Retrying a
lost start, which sends a fresh `Idempotency-Key` and can start a second run.
Steer echoes while the run streams, approval tiers and countdowns, routines,
the connector restarting, and more than one run per thread. Each run's bounds
are in `check.sh`. A pass covers those bounds, not every run.
