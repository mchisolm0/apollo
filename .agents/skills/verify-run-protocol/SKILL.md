---
name: verify-run-protocol
description: Use when a change touches how Apollo on Exact, the connector, or the cloud inbox start runs, steer them, or answer Hermes approvals, or edits any file listed under Coverage. Model-checks every order of those steps, including lost replies, timeouts, and answers from several places.
---

# Verify the run protocol

Two small TLA+ models of how a run passes between the phone, the connector,
the cloud inbox, and Hermes. TLC, the TLA+ model checker, tries every order of
their steps within the bounds in `check.sh` and checks each rule in every state.

`Approvals.tla` is one run asking for approvals, two at once when parallel
subagents ask. The run's status shows only the newest request, so the thread
screen and the connector read the run's events. The thread screen, a cloud card
answered from any phone, and away mode can all answer, and Hermes can time a
request out:

1. **AnswerMatches.** An answer settles only the request it was given for.
2. **ScreenShows.** Once quiet, the thread screen shows a request Hermes waits
   on whenever there is one.
3. **CardForEach.** Once quiet, every request Hermes waits on has an open card.
4. **CardsCurrent.** Once quiet, every open card is for a request Hermes waits
   on.

`Steers.tla` is one thread: created with its first message, steered while it
runs (one steer request in flight at a time, as the composer allows), and
opened again after the run ends. Hermes's history has no steer ids, so the app
counts the lines of the run's steer rows, and the first steers sent that fill
them are the saved ones. Steers can repeat each other's words, span two lines,
share a row (Hermes saves the steers it reads at once as one), and be saved out
of order. History also holds a steer row from an earlier run:

5. **KeepsStarted.** The app never deletes a thread whose run began.
6. **UndeliveredExact.** The reopened thread's note holds the lines of each
   steer Hermes never saved, in the order sent, and no others. It is judged by
   lines because the note joins steers with newlines: `a` and `b` read the
   same as one `a\nb`.

## Run it

```bash
.agents/skills/verify-run-protocol/check.sh             # every run, about 10 seconds
.agents/skills/verify-run-protocol/check.sh blind       # one run, with TLC's full output
```

It needs Java 11 or newer. The first run downloads TLC 1.7.4 into
`~/.cache/apollo` and checks its sha256.

Each `ok` line is a run that went as expected. The app runs (`answers`, `away`,
`steers`) must pass every rule. Each break turns off one thing the code does and
must fail the rule it names, which proves that rule can still catch a bug:

| Break | Turns off | Must fail |
| --- | --- | --- |
| `blind` | sending `request_id` with every answer | AnswerMatches |
| `stale-cards` | the bridge resolving a card once its request closes | CardsCurrent |
| `status-only` | the connector reading the run's events, not only its status | CardForEach |
| `latest-only` | the screen showing the oldest open request, not the latest asked | ScreenShows |
| `delete-start` | `createThread` keeping a thread whose start is uncertain | KeepsStarted |
| `no-reread` | the reopen reading history again after the run's status | UndeliveredExact |
| `count-rows` | counting lines, not rows, so a joined row counts for each steer in it | UndeliveredExact |
| `no-since` | counting only steer rows newer than the history the first steer saw | UndeliveredExact |
| `pending-order` | listing unseen steers in the order sent, not pending_steer's order | UndeliveredExact |

## Known gaps

These runs fail on today's code. Each one checks that it still fails, so it
reports `FAIL ... got pass` once the gap is closed. Then move it to the app runs.

| Gap | Fails | What happens |
| --- | --- | --- |
| `late-reply` | UndeliveredExact | A steer's reply never lands, so the app doesn't track it, but Hermes saves it. Its lines count toward the saved ones, so the reopen misses a dropped steer. Or the first steer's reply lands after the screen drew its saved row, so that row counts as older than the run's steers. Hermes's history has no steer ids, so this is the limit. |

The app runs assume each steer's reply lands before the screen reads history
again (`OnTime`). `late-reply` is the same model without it. They also assume
the screen and the connector drop a timed-out request only after Hermes denied
it: both count from the request's timestamp on Hermes's clock, and the
connector waits 5 seconds more.

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
  prototypes/apollo-spike-app/app.ts prototypes/apollo-spike-app/app.contract \
  src/lib/run-state.ts src/features/relay/transcript.ts \
  connector/index.mjs connector/cloud.mjs connector/away.mjs \
  connector/notifications.mjs connector/run-approvals.mjs cloud/src/inbox.ts
```

## Coverage

Last checked against the covered code on 2026-11-16, and against Hermes at
NousResearch/hermes-agent 40d1e95.

| File | What the models stand for |
| --- | --- |
| `prototypes/apollo-spike-app/app.ts` | `answerApproval` and a request Hermes says is gone, the shown request expiring at its timeout, `steerRun` and the run's `since`, `unseen` counting the lines of the run's steer rows, `createThread` and `start`, the reopen in `transcript` (the second history read, pending_steer, `undelivered`) |
| `prototypes/apollo-spike-app/app.contract` | `canSteer`: no new steer while one is on its way |
| `src/lib/run-state.ts` | `openApprovals` and `currentApproval`: the oldest open request the thread screen shows |
| `src/features/relay/transcript.ts` | `userText`: a saved steer row's words, read from inside Hermes's out-of-band marker |
| `connector/index.mjs` | `answerApproval`: answers by `request_id`, a 4xx means the request is gone |
| `connector/cloud.mjs` | `createApprovalBridge`: a card for each open request, resolving cards whose request closed, answering from card events |
| `connector/away.mjs` | `deny`, by request id |
| `connector/notifications.mjs` | the run monitor: away mode denies every open request first, then the bridge |
| `connector/run-approvals.mjs` | following the run's events for its open requests, dropping timed-out ones, `settled` |
| `cloud/src/inbox.ts` | answering a card resolves it and appends an action event |
| Hermes `gateway/platforms/api_server_runs.py` | the status shows the newest request, answering one returns the run to running, steers only while running |
| Hermes `tools/approval.py` | answering by exact `request_id`, or the oldest without one |
| Hermes `agent/interrupt_control.py` | one drain reads every waiting steer as one joined row, `pending_steer` on a finished run, steers dropped unnamed on a hard stop |
| Hermes `agent/agent_runtime_helpers.py`, `agent/turn_iteration_prep.py` | a steer read after a tool batch goes last, one read just before a model call goes ahead of the rows not saved yet |
| Hermes `gateway/platforms/api_server.py` | `_handle_session_messages`: the latest 500 messages, each with its time and `display_kind` (`steer` for a steer row) |

## Not covered

The model leaves out three things `app.ts` handles without it:
- Compression copies rows under new ids but keeps their time, so `since` is a time
  (`hermes_state_messages.py`).
- A long run can push its saved steers off the latest 500, and compression can summarize them
  away. So the reopen counts from history read back to `since`, including summarized rows
  (`historySince`).
- A steer can quote Hermes's marker, so a steer row's lines are counted inside its first and last
  lines (`steerLines`). A steer row that compression merged a summary into loses its
  `display_kind` but keeps the marker, so the marker also marks a steer row
  (`agent/compaction_display.py`).

Because `since` is a time, a server clock set back after the first steer can leave a saved steer
looking older, and the reopen names it as undelivered. Hermes exposes no row id that survives
compression. The steer echoes drawn while the run streams count from the history shown, so a
saved steer that compression summarized mid-run shows as an echo until the thread reopens.


The Expo app's thread screen, which has its own steer and approval code. Push
notifications and the direct-push fallback when the cloud is down. Retrying a
lost start, which sends a fresh `Idempotency-Key` and can start a second run.
Another phone or client steering the same run, whose steer rows count as this one's. Steer echoes while the run streams, approval tiers and countdowns, routines,
the connector restarting, and more than one run per thread. Each run's bounds
are in `check.sh`. A pass covers those bounds, not every run.
