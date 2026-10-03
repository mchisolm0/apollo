import test from "node:test";
import assert from "node:assert/strict";

import { createExpoPushSender } from "./notifications.mjs";

test("Expo pushes group runs by session without replacing notifications or changing navigation data", async () => {
  const payloads = [];
  const sendPush = createExpoPushSender({
    fetchImpl: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return Response.json({ data: { status: "ok", id: "ticket" } });
    },
  });
  for (const [sessionId, runId, kind] of [["session_1", "run_1", "approval"], ["session_1", "run_2", "completed"], ["session_2", "run_3", "failed"]]) {
    const data = { kind, agent_id: "agent_1", session_id: sessionId, run_id: runId };
    assert.deepEqual(await sendPush("ExpoPushToken[test]", { title: "Run update", body: "Open Ekho.", data }), { status: "ok" });
    assert.deepEqual(payloads.at(-1), {
      to: "ExpoPushToken[test]", sound: "default", channelId: "runs", threadId: sessionId,
      title: "Run update", body: "Open Ekho.", data,
    });
  }
  assert.equal(payloads[0].threadId, payloads[1].threadId);
  assert.notEqual(payloads[1].threadId, payloads[2].threadId);
});
