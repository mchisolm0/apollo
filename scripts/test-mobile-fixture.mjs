#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnectorServer } from "../connector/index.mjs";

const HOST = "127.0.0.1";
const CONNECTOR_PORT = 19101;
const HERMES_PORT = 19102;
const ROOT = "/tmp/apollo-mobile-check";
const PAIRING_FILE = join(ROOT, "pairing-link.txt");
const STATE_FILE = join(ROOT, "connector-state.json");
const ADMIN_SECRET = "apollo-fixture-admin";

const sessions = new Map([
  ["fixture-session", { id: "fixture-session", title: "Fixture thread", source: "fixture", message_count: 0, last_active: Date.now() / 1000 }],
]);
const messages = new Map([["fixture-session", []]]);
const runs = new Map();
const idempotency = new Map();
const subscribers = new Map();
let offline = false;

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function runStatus(run) {
  return { run_id: run.id, status: run.status, session_id: run.sessionId, output: run.output, approval: run.approval, created_at: run.createdAt, updated_at: Date.now() / 1000 };
}

function emit(run, event, extra = {}) {
  const message = JSON.stringify({ event_id: `${run.id}-${run.events.length}`, event, run_id: run.id, timestamp: Date.now() / 1000, ...extra });
  run.events.push(message);
  for (const response of subscribers.get(run.id) ?? []) response.write(`data: ${message}\n\n`);
}

function finish(run) {
  if (["completed", "cancelled"].includes(run.status)) return;
  run.status = "completed";
  run.output = "## Result\n\nDone. The fixture streamed a **markdown** response with a [link](https://example.com).\n\n```typescript\nconst count = 42;\nconsole.log(count);\n```\n\n```diff\ndiff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-const count = 1;\n+const count = 42;\n```";
  messages.get(run.sessionId)?.push({ id: `assistant-${run.id}`, role: "assistant", content: run.output, timestamp: Date.now() / 1000 });
  emit(run, "message.delta", { text: run.output });
  emit(run, "run.completed", { text: run.output });
  for (const response of subscribers.get(run.id) ?? []) response.end();
  subscribers.delete(run.id);
}

function schedule(run) {
  setTimeout(() => { if (run.status === "started") emit(run, "run.started"); }, 25);
  setTimeout(() => { if (run.status === "started") { run.status = "running"; emit(run, "tool.started", { tool: "fixture-search", preview: "Searching fixture data" }); } }, 400);
  setTimeout(() => { if (run.status === "running") emit(run, "tool.progress", { tool: "fixture-search", preview: "1 result" }); }, 800);
  setTimeout(() => { if (run.status === "running") emit(run, "tool.completed", { tool: "fixture-search", preview: "Search complete" }); }, 1200);
  setTimeout(() => {
    if (run.status !== "running") return;
    if (/approval/i.test(run.input)) {
      run.status = "waiting_for_approval";
      run.approval = { request_id: `approval-${run.id}`, tool: "shell", command: "echo fixture" };
      emit(run, "approval.request", run.approval);
    } else if (!/hold/i.test(run.input)) finish(run);
  }, 3000);
}

const hermes = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (["/batch", "/batch/", "/flags", "/flags/", "/decide", "/decide/", "/capture/", "/e/"].includes(url.pathname)) { await body(req); return json(res, 200, { status: "ok", featureFlags: {}, featureFlagPayloads: {} }); }
  if (url.pathname === "/__fixture/offline" && req.method === "POST") { offline = true; return json(res, 200, { offline }); }
  if (url.pathname === "/__fixture/online" && req.method === "POST") { offline = false; return json(res, 200, { offline }); }
  if (url.pathname === "/__fixture/complete" && req.method === "POST") { runs.forEach(finish); return json(res, 200, { completed: runs.size }); }
  if (url.pathname === "/__fixture/state" && req.method === "GET") return json(res, 200, { offline, runs: runs.size, idempotencyKeys: idempotency.size, sessions: sessions.size });
  if (offline) return json(res, 503, { error: { message: "Fixture Hermes is offline", code: "fixture_offline" } });
  if (url.pathname === "/v1/capabilities") return json(res, 200, { object: "hermes.api_server.capabilities", platform: "fixture", model: "fixture", features: ["runs", "sessions"] });
  if (url.pathname === "/v1/health") return json(res, 200, { status: "ok" });
  if (url.pathname === "/v1/inbox") return json(res, 200, { settled: {} });
  if (url.pathname === "/api/sessions" && req.method === "GET") return json(res, 200, { data: [...sessions.values()] });
  if (url.pathname === "/api/sessions" && req.method === "POST") {
    const input = await body(req); const id = input.id ?? randomUUID();
    if (sessions.has(id)) return json(res, 409, { error: { code: "session_exists", message: "Session exists" } });
    const session = { id, title: input.title ?? "New fixture thread", source: "fixture", message_count: 0, last_active: Date.now() / 1000 };
    sessions.set(id, session); messages.set(id, []); return json(res, 201, { session });
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/u);
  if (sessionMatch && req.method === "GET") return sessions.has(sessionMatch[1]) ? json(res, 200, { session: sessions.get(sessionMatch[1]) }) : json(res, 404, { error: { message: "Unknown session" } });
  if (sessionMatch && req.method === "PATCH") { const input = await body(req); const session = sessions.get(sessionMatch[1]); if (!session) return json(res, 404, { error: { message: "Unknown session" } }); session.title = input.title ?? session.title; return json(res, 200, { session }); }
  const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/u);
  if (messagesMatch) return json(res, 200, { data: messages.get(messagesMatch[1]) ?? [] });
  if (url.pathname === "/v1/runs" && req.method === "POST") {
    const key = req.headers["idempotency-key"];
    if (typeof key === "string" && idempotency.has(key)) return json(res, 202, runStatus(idempotency.get(key)));
    const input = await body(req); const run = { input: input.input ?? "", createdAt: Date.now() / 1000, id: `fixture-run-${randomUUID()}`, sessionId: input.session_id ?? "fixture-session", status: "started", events: [], output: undefined };
    messages.get(run.sessionId)?.push({ id: `user-${run.id}`, role: "user", content: run.input, timestamp: run.createdAt });
    runs.set(run.id, run); if (typeof key === "string") idempotency.set(key, run); schedule(run); return json(res, 202, runStatus(run));
  }
  const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events|stop|approval))?$/u);
  if (runMatch) {
    const run = runs.get(runMatch[1]); if (!run) return json(res, 404, { error: { message: "Unknown run" } });
    if (!runMatch[2] && req.method === "GET") return json(res, 200, runStatus(run));
    if (runMatch[2] === "events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const event of run.events) res.write(`data: ${event}\n\n`);
      if (run.status === "completed" || run.status === "cancelled") return res.end();
      const active = subscribers.get(run.id) ?? new Set(); active.add(res); subscribers.set(run.id, active); req.on("close", () => active.delete(res)); return;
    }
    if (runMatch[2] === "stop") { run.status = "cancelled"; emit(run, "run.cancelled"); return json(res, 200, runStatus(run)); }
    if (runMatch[2] === "approval") { const input = await body(req); run.status = "running"; run.approval = undefined; emit(run, "approval.responded"); setTimeout(() => finish(run), 1500); return json(res, 200, { run_id: run.id, choice: input.choice ?? "deny", resolved: 1 }); }
  }
  json(res, 404, { error: { message: "Fixture route not found" } });
});

await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true, mode: 0o700 });
await new Promise((resolve, reject) => hermes.listen(HERMES_PORT, HOST, (error) => error ? reject(error) : resolve()));
const connector = createConnectorServer({ host: HOST, port: CONNECTOR_PORT, hermesUrl: `http://${HOST}:${HERMES_PORT}`, hermesApiKey: "fixture-hermes", adminSecret: ADMIN_SECRET, statePath: STATE_FILE, label: "Apollo mobile fixture", generateThreadTitle: async (input) => `Fixture: ${input.slice(0, 36)}` });
await connector.start();
const pairResponse = await fetch(`http://${HOST}:${CONNECTOR_PORT}/admin/pair`, { method: "POST", headers: { "x-apollo-admin-secret": ADMIN_SECRET, "content-type": "application/json" }, body: JSON.stringify({ public_base_url: `http://${HOST}:${CONNECTOR_PORT}`, device_name: "Mobile simulator" }) });
const pair = await pairResponse.json();
await writeFile(PAIRING_FILE, `${pair.pairing_url}\n`, { mode: 0o600 });

console.log(`Fixture connector: http://${HOST}:${CONNECTOR_PORT}`);
console.log(`Fixture Hermes: http://${HOST}:${HERMES_PORT}`);
console.log(`Pairing link file: ${PAIRING_FILE}`);
console.log(`Controls: curl -X POST http://${HOST}:${HERMES_PORT}/__fixture/complete`);
console.log(`          curl -X POST http://${HOST}:${HERMES_PORT}/__fixture/offline`);
console.log(`          curl -X POST http://${HOST}:${HERMES_PORT}/__fixture/online`);

process.on("SIGINT", async () => { await connector.close(); await new Promise((resolve) => hermes.close(resolve)); process.exit(0); });
