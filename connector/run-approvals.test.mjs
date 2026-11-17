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
  events.push({ event: "approval.responded" });
  await tracker.follow("run", new AbortController().signal);
  assert.deepEqual((await tracker.open("run", waiting)).map((ask) => ask.request_id), []);
  // Hermes's status keeps showing a timed-out request; it stays gone.
  assert.deepEqual((await tracker.open("run", { status: "waiting_for_approval", approval: { request_id: "a" } })).map((ask) => ask.request_id), []);
  // The status's request counts until the stream shows it.
  assert.deepEqual((await tracker.open("run", { status: "waiting_for_approval", approval: { request_id: "d" } })).map((ask) => ask.request_id), ["d"]);
});
