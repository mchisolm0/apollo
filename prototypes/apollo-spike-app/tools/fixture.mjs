#!/usr/bin/env node
// PROTOTYPE, throwaway. A fake Hermes behind Apollo's real connector, for the Exact spike.
// Forked from scripts/test-mobile-fixture.mjs with its own ports and state dir, word-by-word
// deltas, reasoning, tool call ids, and a "storm" input that floods 2,000 deltas to check
// whether Exact's SSE reader drops any. GET /__spike/credential hands the app a paired token.
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnectorServer } from "../../../connector/index.mjs";

const HOST = "127.0.0.1";
const CONNECTOR_PORT = 19111;
const HERMES_PORT = 19112;
const ROOT = "/tmp/apollo-exact-spike";
const ADMIN_SECRET = "apollo-exact-spike-admin";

const ANSWER = "## Result\n\nDone. The fixture streamed this **markdown** answer word by word, with a [link](https://example.com) and a list:\n\n- first item\n- second item with `inline code`\n\n```typescript\nconst count = 42;\nconsole.log(count);\n```\n\n| Column | Value |\n| --- | --- |\n| speed | fast |\n| words | many |\n\nThat is the end of the answer.";

const now = () => Date.now() / 1000;
const sessions = new Map([["spike-session", { id: "spike-session", title: "Spike thread", source: "fixture", message_count: 2, last_active: now() }]]);
const messages = new Map([["spike-session", [
  { id: "seed-user", role: "user", content: "What does this thread show?", timestamp: now() - 60 },
  { id: "seed-tool-call", role: "assistant", content: "", tool_calls: [{ id: "call-seed", function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) } }], timestamp: now() - 58 },
  { id: "seed-tool", role: "tool", tool_call_id: "call-seed", tool_name: "read_file", content: JSON.stringify({ success: true, content: "# Apollo" }), timestamp: now() - 57 },
  { id: "seed-assistant", role: "assistant", content: "It shows **history** from the connector: a user turn, a tool call, and this answer.", timestamp: now() - 55 },
]]]);
const runs = new Map();
const idempotency = new Map();
const subscribers = new Map();
let credential;

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const runStatus = (run) => ({ run_id: run.id, status: run.status, session_id: run.sessionId, output: run.output, approval: run.approval, created_at: run.createdAt, updated_at: now() });

function emit(run, event, extra = {}) {
  const message = JSON.stringify({ event_id: `${run.id}-${run.events.length}`, event, run_id: run.id, timestamp: now(), ...extra });
  run.events.push(message);
  for (const response of subscribers.get(run.id) ?? []) response.write(`data: ${message}\n\n`);
}

function end(run) {
  for (const response of subscribers.get(run.id) ?? []) response.end();
  subscribers.delete(run.id);
}

// Streams `text` as deltas, `every` ms apart, then completes the run.
function stream(run, text, every) {
  const words = text.split(/(?<=\s)/u);
  let i = 0;
  const tick = () => {
    if (run.status !== "running") return;
    if (i < words.length) { emit(run, "message.delta", { delta: words[i++] }); return void setTimeout(tick, every); }
    run.status = "completed";
    run.output = text;
    messages.get(run.sessionId)?.push({ id: `assistant-${run.id}`, role: "assistant", content: text, timestamp: now() });
    emit(run, "run.completed", { output: text });
    end(run);
  };
  tick();
}

function answer(run) {
  if (/storm/i.test(run.input)) return stream(run, Array.from({ length: 2000 }, (_, n) => `w${n + 1} `).join(""), 0);
  stream(run, ANSWER, 35);
}

function schedule(run) {
  setTimeout(() => { if (run.status === "started") { run.status = "running"; emit(run, "run.started"); emit(run, "reasoning.available", { text: "Checking the fixture before answering." }); } }, 25);
  setTimeout(() => { if (run.status === "running") emit(run, "tool.started", { tool: "terminal", tool_call_id: `call-${run.id}`, preview: "ls -la" }); }, 300);
  setTimeout(() => { if (run.status === "running") emit(run, "tool.completed", { tool: "terminal", tool_call_id: `call-${run.id}`, preview: "4 files", duration: 0.4 }); }, 700);
  setTimeout(() => {
    if (run.status !== "running") return;
    if (/approval/i.test(run.input)) {
      run.status = "waiting_for_approval";
      run.approval = { request_id: `approval-${run.id}`, tool: "terminal", command: "rm -rf build/", description: "Clean the build folder" };
      emit(run, "approval.request", run.approval);
    } else if (!/hold/i.test(run.input)) answer(run);
  }, 900);
}

const hermes = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/__spike/credential") return json(res, 200, credential);
  if (url.pathname === "/v1/capabilities") return json(res, 200, { object: "hermes.api_server.capabilities", platform: "fixture", model: "fixture", features: ["runs", "sessions"] });
  if (url.pathname === "/v1/health") return json(res, 200, { status: "ok" });
  if (url.pathname === "/api/sessions" && req.method === "GET") return json(res, 200, { data: [...sessions.values()] });
  if (url.pathname === "/api/sessions" && req.method === "POST") {
    const input = await body(req); const id = input.id ?? randomUUID();
    if (sessions.has(id)) return json(res, 409, { error: { code: "session_exists", message: "Session exists" } });
    const session = { id, title: input.title ?? "New spike thread", source: "fixture", message_count: 0, last_active: now() };
    sessions.set(id, session); messages.set(id, []); return json(res, 201, { session });
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/u);
  if (sessionMatch && req.method === "GET") return sessions.has(sessionMatch[1]) ? json(res, 200, { session: sessions.get(sessionMatch[1]) }) : json(res, 404, { error: { message: "Unknown session" } });
  const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/u);
  if (messagesMatch) return json(res, 200, { data: messages.get(messagesMatch[1]) ?? [] });
  if (url.pathname === "/v1/runs" && req.method === "POST") {
    const key = req.headers["idempotency-key"];
    if (typeof key === "string" && idempotency.has(key)) return json(res, 202, runStatus(idempotency.get(key)));
    const input = await body(req);
    const run = { input: input.input ?? "", createdAt: now(), id: `spike-run-${randomUUID()}`, sessionId: input.session_id ?? "spike-session", status: "started", events: [], output: undefined };
    messages.get(run.sessionId)?.push({ id: `user-${run.id}`, role: "user", content: run.input, timestamp: run.createdAt });
    runs.set(run.id, run); if (typeof key === "string") idempotency.set(key, run); schedule(run); return json(res, 202, runStatus(run));
  }
  const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events|stop|approval))?$/u);
  if (runMatch) {
    const run = runs.get(runMatch[1]); if (!run) return json(res, 404, { error: { message: "Unknown run" } });
    if (!runMatch[2] && req.method === "GET") return json(res, 200, runStatus(run));
    if (runMatch[2] === "events" && req.method === "GET") {
      // Stands in for the connector change Exact would need: a client that asks for bytes gets the
      // same SSE frames labelled as bytes, which Exact reads losslessly.
      const bytes = req.headers.accept === "application/octet-stream";
      res.writeHead(200, { "content-type": bytes ? "application/octet-stream" : "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const event of run.events) res.write(`data: ${event}\n\n`);
      if (["completed", "cancelled"].includes(run.status)) return res.end();
      const active = subscribers.get(run.id) ?? new Set(); active.add(res); subscribers.set(run.id, active); req.on("close", () => active.delete(res)); return;
    }
    if (runMatch[2] === "stop") { run.status = "cancelled"; emit(run, "run.cancelled"); end(run); return json(res, 200, runStatus(run)); }
    if (runMatch[2] === "approval") {
      const input = await body(req); run.approval = undefined; emit(run, "approval.responded");
      if (input.choice === "deny") { run.status = "running"; stream(run, "Okay, I left the build folder alone.", 35); }
      else { run.status = "running"; emit(run, "tool.started", { tool: "terminal", tool_call_id: `call-rm-${run.id}`, preview: "rm -rf build/" }); emit(run, "tool.completed", { tool: "terminal", tool_call_id: `call-rm-${run.id}`, preview: "removed", duration: 0.1 }); stream(run, "Cleaned the build folder.", 35); }
      return json(res, 200, { run_id: run.id, choice: input.choice ?? "deny", resolved: 1 });
    }
  }
  json(res, 404, { error: { message: "Fixture route not found" } });
});

await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true, mode: 0o700 });
await new Promise((resolve, reject) => hermes.listen(HERMES_PORT, HOST, (error) => error ? reject(error) : resolve()));
const connector = createConnectorServer({ host: HOST, port: CONNECTOR_PORT, hermesUrl: `http://${HOST}:${HERMES_PORT}`, hermesApiKey: "fixture-hermes", adminSecret: ADMIN_SECRET, statePath: join(ROOT, "connector-state.json"), label: "Exact spike fixture", generateThreadTitle: async (input) => `Spike: ${input.slice(0, 36)}` });
await connector.start();
const base = `http://${HOST}:${CONNECTOR_PORT}`;
const pair = await (await fetch(`${base}/admin/pair`, { method: "POST", headers: { "x-apollo-admin-secret": ADMIN_SECRET, "content-type": "application/json" }, body: JSON.stringify({ device_name: "Exact spike" }) })).json();
const exchange = await (await fetch(`${base}/v1/pair/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair.pairing_token, device_name: "Exact spike" }) })).json();
credential = { endpoint: base, token: exchange.access_token };

console.log(`Connector: ${base}  Fake Hermes: http://${HOST}:${HERMES_PORT}`);
console.log(`Inputs: "approval" asks to run a command, "hold" never finishes, "storm" floods 2,000 deltas.`);
process.on("SIGINT", async () => { await connector.close(); await new Promise((resolve) => hermes.close(resolve)); process.exit(0); });
