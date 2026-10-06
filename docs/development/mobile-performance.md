# Mobile verification

Use `pnpm ios:dev` to build Apollo Dev and `pnpm start:dev` to serve its bundle. The development variant has its own bundle identifier, URL scheme, and app storage. Rebuild after changing native dependencies. Do not connect this client to a daily-driver Hermes instance for tests without explicit authorization.

## Automated checks

`pnpm test:mobile` exercises the same transcript and inbox interfaces used by the app. The inbox projection test asserts that streamed text preserves the list and row references, while an approval updates only the affected row. The long-transcript test asserts row identity is preserved when only the streaming tail changes. It also has a generous wall-time ceiling to catch catastrophic regressions. CI runs these checks alongside TypeScript, ESLint, and connector tests.

This is a projection-cost check, not an FPS guarantee. LegendList recycles rows; memoized message rendering and history projection preserve unchanged work. Expanded tool output is only mounted on demand. The active stream is published in 50ms batches.

## Device performance baseline

Before setting a device-level performance budget, run a release build on a named representative device with a fixed long-thread fixture. Record:

- device, OS, build commit, transcript row count, and stream cadence;
- frame times and JS stalls during streaming and scrolling;
- memory before and after traversing the thread;
- whether expanding tools or code moves the reader unexpectedly;
- whether reconnecting duplicates messages or starts another run.

Keep the trace and screenshots outside the repository. Compare the same build configuration and fixture when evaluating changes. A simulator debug build is useful for behavior and layout; it does not establish release-device frame-time performance.

## Backend constraints

The current connector exposes Hermes text runs and approvals, but no attachment upload endpoint. Messages can render Markdown images, links, tables, and highlighted code using the native renderer. Pasting a URL or code into the composer is supported. Uploading pictures requires a verified Hermes/connector protocol change.

Hermes may discard a consumed event stream. If SSE fails, Apollo reconciles run status and durable session messages through polling. Tool updates may be unavailable during this fallback; never infer current tool progress from old events.


## Inbox navigation verification

Session routes use a native stack. Opening a task pushes a full-width conversation, and Back to tasks returns to the inbox. Its rows use already-loaded sessions and expose Finish/Reopen through a left swipe, native action sheet, and accessibility actions. Running tasks and pending approvals cannot be finished.

Check opening a task, the native back gesture, search with the keyboard, finish/reopen, and a saved draft after relaunch. Repeat navigation during an active run. In a thread, opening the keyboard must preserve readable content, and expanding tool details must preserve the reading position. Record simulator evidence outside the worktree. Measure release-device frame times separately before claiming a frame-rate budget.


Hermes events without explicit event IDs cannot be safely deduplicated by timestamp and payload: two identical chunks may be legitimate. A replay after reconnect can repeat live progress until durable history reconciliation. Explicit event IDs or sequence values are deduplicated. A protocol-level replay cursor is the remaining fix for reliable incremental recovery.

## Physical-device pairing verification

Matthew confirmed on September 6, 2026 that camera pairing was verified on a physical device in prior work. The subsequent direction A simulator UI pass did not repeat that check; its simulator-only scope does not invalidate the earlier result.
