import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalTracker } from "./run-approvals.mjs";

const waiting = { status: "running" };

test("requests close by id, an answer without one closes the oldest, and a timed-out request is gone", async () => {
  const now = Date.now() / 1000;
  const events = [
    { event: "approval.request", request_id: "a", timestamp: now - 400 },
    { event: "approval.request", request_id: "b", timestamp: now },
    { event: "approval.request", request_id: "c", timestamp: now },
    { event: "approval.responded", request_id: "c" },
  ];
  const tracker = createApprovalTracker({
    readEvents: async (_runId, after, onEvent) => { events.forEach((event, seq) => { if (seq > after) onEvent(seq, event); }); return false; },
    timeoutSeconds: async () => 300,
  });
  await tracker.follow("run", new AbortController().signal);
  // a asked 400s ago with a 300s timeout: Hermes has denied it.
  assert.deepEqual((await tracker.open("run", waiting)).map((ask) => ask.request_id), ["b"]);
  events.push({ event: "approval.responded", timestamp: now });
  await tracker.follow("run", new AbortController().signal);
  assert.deepEqual((await tracker.open("run", waiting)).map((ask) => ask.request_id), []);
  // Hermes's status keeps showing a timed-out request; it stays gone.
  assert.deepEqual((await tracker.open("run", { status: "waiting_for_approval", approval: { request_id: "a" } })).map((ask) => ask.request_id), []);
  // The status's request counts until the stream shows it.
  assert.deepEqual((await tracker.open("run", { status: "waiting_for_approval", approval: { request_id: "d" } })).map((ask) => ask.request_id), ["d"]);
});

test("a request keeps the timeout Hermes captured, a replay can't reopen a gone one, and an id-less answer skips expired ones", async () => {
  const now = Date.now() / 1000;
  const events = [
    // b asked first with 60s and timed out 35s ago, before the id-less answer below.
    { event: "approval.request", request_id: "b", timestamp: now - 100, timeout_s: 60 },
    // a asked with 600s; the config has since dropped to 30s.
    { event: "approval.request", request_id: "a", timestamp: now - 90, timeout_s: 600 },
    { event: "approval.request", request_id: "c", timestamp: now - 10, timeout_s: 600 },
    { event: "approval.request", request_id: "gone", timestamp: now - 5, timeout_s: 600 },
    // Hermes settled a, the oldest still waiting then, not the timed-out b.
    { event: "approval.responded", timestamp: now - 1 },
  ];
  const tracker = createApprovalTracker({
    readEvents: async (_runId, after, onEvent) => { events.forEach((event, seq) => { if (seq > after) onEvent(seq, event); }); return false; },
    timeoutSeconds: async () => 30,
  });
  // A stale card answer said "gone" before the replay reached that request.
  tracker.gone("run", "gone");
  await tracker.follow("run", new AbortController().signal);
  assert.deepEqual((await tracker.open("run", waiting)).map((ask) => ask.request_id), ["c"]);
});

test("an id-less answer settles what Hermes settled, whatever was said gone here or is in its grace", async () => {
  const now = Date.now() / 1000;
  const streams = {
    // a timed out 2s ago, so the id-less answer 1s ago settled b; a's card waits out its grace.
    grace: [
      { event: "approval.request", request_id: "a", timestamp: now - 62, timeout_s: 60 },
      { event: "approval.request", request_id: "b", timestamp: now - 61, timeout_s: 600 },
      { event: "approval.responded", timestamp: now - 1 },
    ],
    // Another client answered a without an id; a stale card answer for a heard "gone" first.
    gone: [
      { event: "approval.request", request_id: "a", timestamp: now - 10, timeout_s: 600 },
      { event: "approval.request", request_id: "b", timestamp: now - 9, timeout_s: 600 },
      { event: "approval.responded", timestamp: now - 1 },
    ],
  };
  const tracker = createApprovalTracker({
    readEvents: async (runId, after, onEvent, _signal, onOpen) => { onOpen(); streams[runId].forEach((event, seq) => { if (seq > after) onEvent(seq, event); }); return true; },
    timeoutSeconds: async () => 0,
  });
  tracker.gone("gone", "a");
  for (const runId of ["grace", "gone"]) {
    const done = new AbortController();
    const following = tracker.follow(runId, done.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    done.abort();
    await following;
  }
  assert.deepEqual((await tracker.open("grace", waiting)).map((ask) => ask.request_id), ["a"]);
  assert.deepEqual([...tracker.settled("grace")], ["b"]);
  assert.deepEqual((await tracker.open("gone", waiting)).map((ask) => ask.request_id), ["b"]);
});
