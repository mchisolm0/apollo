#!/usr/bin/env node
// PROTOTYPE, throwaway. A fake Hermes behind Apollo's real connector, for the Exact spike.
// Forked from scripts/test-mobile-fixture.mjs with its own ports and state dir, word-by-word
// deltas, reasoning, tool call ids, and a "storm" input that floods 2,000 deltas to check
// whether Exact's SSE reader drops any. POST /__spike/pair on the fake Hermes port mints a pairing link.
// A fake cloud inbox on :19113 holds a morning card, an update and an approval, and takes the
// connector's own approval cards, so the app's inbox can be driven without the real Worker.
// The app reaches the connector through a front door on :19111 that adds CORS (so `test web`
// can call it) and takes the reusable link `apollo://pair?host=http%3A%2F%2F127.0.0.1%3A19111#token=fixture`:
// pairing with it puts Hermes and the cloud back to their seed first, so each contract test starts
// from the same data.
import { createServer, request as httpRequest } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnectorServer } from "../../../connector/index.mjs";

const HOST = "127.0.0.1";
const FRONT_PORT = 19111;
const CONNECTOR_PORT = 19110;
const HERMES_PORT = 19112;
const CLOUD_PORT = 19113;
const ROOT = "/tmp/apollo-exact-spike";
const ADMIN_SECRET = "apollo-exact-spike-admin";

const ANSWER = "## Result\n\nDone. The fixture streamed this **markdown** answer word by word, with a [link](https://example.com) and a list:\n\n- first item\n- second item with `inline code`\n\n```typescript\nconst count = 42;\nconsole.log(count);\n```\n\n| Column | Value |\n| --- | --- |\n| speed | fast |\n| words | many |\n\nThat is the end of the answer.";

const now = () => Date.now() / 1000;
// A cron job's own run, and the Bot Chat its output went to. Hermes previews both with the
// first user message, which cron wrote for the agent.
const BOT_CHAT_INPUT = '[Cronjob "Lot watcher" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\nNo lot met the bar. Best seen: 2 Galaxy A03s at $24.65 each.';
let sessions, messages, runs, idempotency, cards, events, rev, seq;
const seedSessions = () => new Map([
  ["spike-session", { id: "spike-session", title: "Spike thread", source: "fixture", message_count: 2, last_active: now() }],
  ["cron-run", { id: "cron-run", title: "Lot watcher · Nov 12 12:05", source: "cron", message_count: 2, last_active: now() - 120, ended_at: now() - 120, preview: "[IMPORTANT: You are running as a scheduled cron job. DELIVER..." }],
  ["bot-chat", { id: "bot-chat", title: "Bot Chat", source: "cli", message_count: 2, last_active: now() - 90, preview: `${BOT_CHAT_INPUT.slice(0, 60)}...` }],
]);
const seedMessages = () => new Map([["spike-session", [
  { id: "seed-user", role: "user", content: "What does this thread show?", timestamp: now() - 60 },
  { id: "seed-tool-call", role: "assistant", content: "", tool_calls: [{ id: "call-seed", function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) } }], timestamp: now() - 58 },
  { id: "seed-tool", role: "tool", tool_call_id: "call-seed", tool_name: "read_file", content: JSON.stringify({ success: true, content: "# Apollo" }), timestamp: now() - 57 },
  { id: "seed-assistant", role: "assistant", content: "It shows **history** from the connector: a user turn, a tool call, and this answer.", timestamp: now() - 55 },
]], ["cron-run", [
  { id: "cron-prompt", role: "user", content: "[IMPORTANT: You are running as a scheduled cron job. DELIVER your final answer as your reply.]\n\nFind phone lots.", timestamp: now() - 180 },
  { id: "cron-answer", role: "assistant", content: "No lot met the bar.", timestamp: now() - 120 },
]], ["bot-chat", [
  { id: "bot-input", role: "user", content: BOT_CHAT_INPUT, timestamp: now() - 100 },
  { id: "bot-answer", role: "assistant", content: "Lot watcher test run: nothing bought. The best lot was 2 Galaxy A03s at $24.65 each.", timestamp: now() - 90 },
]]]);
const subscribers = new Map();
// Hermes's cron jobs as `GET /api/jobs` lists them: one fine, one failing, one paused.
const hour = 3600;
const isoAt = (seconds) => new Date(seconds * 1000).toISOString();
const jobs = () => [
  { id: "job-morning", name: "morning-card", enabled: true, state: "scheduled", schedule: { kind: "cron", expr: "45 8 * * *" }, schedule_display: "45 8 * * *", last_status: "ok", last_run_at: isoAt(now() - 2 * hour), next_run_at: isoAt(now() + 22 * hour), last_error: null, failure_streak: 0, deliver: "apollo", no_agent: true },
  { id: "job-triage", name: "pr-triage", enabled: true, state: "scheduled", schedule: { kind: "cron", expr: "35 8 * * 1-5" }, schedule_display: "35 8 * * 1-5", last_status: "ok", last_run_at: isoAt(now() - 2.2 * hour), next_run_at: isoAt(now() + 21.8 * hour), last_error: null, failure_streak: 0, deliver: "discord" },
  { id: "job-lots", name: "Lot watcher", enabled: true, state: "scheduled", schedule: { kind: "interval", minutes: 30 }, schedule_display: "every 30m", last_status: "error", last_run_at: isoAt(now() - 0.3 * hour), next_run_at: isoAt(now() + 0.2 * hour), last_error: "eBay search timed out after 60s", failure_streak: 3, deliver: "bot-chat" },
  { id: "job-digest", name: "digest", enabled: false, state: "paused", schedule: { kind: "cron", expr: "0 8 * * 1" }, schedule_display: "0 8 * * 1", last_status: "ok", last_run_at: isoAt(now() - 80 * hour), next_run_at: null, paused_at: isoAt(now() - 30 * hour), last_error: null, failure_streak: 0, deliver: "apollo" },
];

// `*` doesn't cover Authorization, so a preflight's asked-for headers are echoed back.
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS", "access-control-expose-headers": "*" };
const preflight = (req, res) => { res.writeHead(204, { ...CORS, "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "*" }); res.end(); };

function json(res, status, body) {
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const runStatus = (run) => ({ run_id: run.id, status: run.status, session_id: run.sessionId, output: run.output, approval: run.approval, created_at: run.createdAt, updated_at: now(), ...(run.pendingSteer ? { pending_steer: run.pendingSteer } : {}) });

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
      // "once only" is Hermes's smart deny: neither the thread nor the permanent tier is offered.
      const choices = /once only/i.test(run.input) ? ["once", "deny"] : ["once", "session", "always", "deny"];
      run.approval = { request_id: `approval-${run.id}`, tool: "terminal", command: "rm -rf build/", description: "Clean the build folder", choices };
      emit(run, "approval.request", run.approval);
    } else if (!/hold/i.test(run.input)) answer(run);
  }, 900);
}

const hermes = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/__spike/pair" && req.method === "POST") return json(res, 200, { link: await pairingLink() });
  if (url.pathname === "/v1/capabilities") return json(res, 200, { object: "hermes.api_server.capabilities", platform: "fixture", model: "fixture", features: ["runs", "sessions"] });
  if (url.pathname === "/v1/health") return json(res, 200, { status: "ok" });
  if (url.pathname === "/api/jobs" && req.method === "GET") return json(res, 200, { jobs: jobs() });
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
    console.log(`run ${input.session_id}: model=${input.model ?? "-"} provider=${input.provider ?? "-"} instructions=${input.instructions ? "yes" : "no"} attachments=${/<apollo-attachments>/.test(input.input ?? "") ? "yes" : "no"}`);
    const run = { input: input.input ?? "", createdAt: now(), id: `spike-run-${randomUUID()}`, sessionId: input.session_id ?? "spike-session", status: "started", events: [], output: undefined };
    messages.get(run.sessionId)?.push({ id: `user-${run.id}`, role: "user", content: run.input, timestamp: run.createdAt });
    runs.set(run.id, run); if (typeof key === "string") idempotency.set(key, run); schedule(run); return json(res, 202, runStatus(run));
  }
  const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events|stop|approval|steer))?$/u);
  if (runMatch) {
    const run = runs.get(runMatch[1]); if (!run) return json(res, 404, { error: { message: "Unknown run" } });
    if (!runMatch[2] && req.method === "GET") return json(res, 200, runStatus(run));
    if (runMatch[2] === "events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const event of run.events) res.write(`data: ${event}\n\n`);
      if (["completed", "cancelled"].includes(run.status)) return res.end();
      const active = subscribers.get(run.id) ?? new Set(); active.add(res); subscribers.set(run.id, active); req.on("close", () => active.delete(res)); return;
    }
    // A steer lands in history as Hermes saves one; a "hold" run finishes on it.
    if (runMatch[2] === "steer") {
      const input = await body(req);
      if (run.status !== "running" || /too late/i.test(input.input ?? "")) return json(res, 409, { error: { code: "run_not_accepting_steer", message: `Run is not currently accepting steer input: ${run.id}` } });
      emit(run, "run.steered", { accepted: true });
      // "never mind" ends the run before the agent reads it, so Hermes hands back every steer still
      // waiting as pending_steer, joined with newlines.
      run.waiting = [...(run.waiting ?? []), input.input];
      if (/never mind/i.test(input.input ?? "")) setTimeout(() => {
        run.status = "completed"; run.output = "Stopped early."; run.pendingSteer = run.waiting.join("\n");
        messages.get(run.sessionId)?.push({ id: `assistant-${run.id}`, role: "assistant", content: run.output, timestamp: now() });
        emit(run, "run.completed", { output: run.output, pending_steer: run.pendingSteer }); end(run);
      }, 600);
      // Otherwise Hermes saves the steer when the agent reads it: a moment later, or at once for a
      // "quick" run, which keeps holding.
      else setTimeout(() => {
        if (run.pendingSteer) return;
        run.waiting = run.waiting.filter((text) => text !== input.input);
        messages.get(run.sessionId)?.push({ id: `steer-${run.events.length}-${run.id}`, role: "user", content: `[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]\n${input.input}\n[/OUT-OF-BAND USER MESSAGE]`, timestamp: now() });
        if (/hold/i.test(run.input) && !/quick/i.test(run.input)) stream(run, `Steered: ${input.input}`, 35);
      }, /quick/i.test(run.input) ? 0 : /slow/i.test(run.input) ? 5000 : 800);
      return json(res, 200, { object: "hermes.run.steer", run_id: run.id, accepted: true });
    }
    if (runMatch[2] === "stop") { run.status = "cancelled"; emit(run, "run.cancelled"); end(run); return json(res, 200, runStatus(run)); }
    if (runMatch[2] === "approval") {
      // As Hermes: an answer must name the open request and one of its offered tiers. The reply
      // names the tier, so a test can tell which one the app sent.
      const input = await body(req);
      if (!run.approval || input.request_id !== run.approval.request_id) return json(res, 409, { error: { code: "approval_not_pending", message: "That request was already answered." } });
      if (!run.approval.choices.includes(input.choice)) return json(res, 400, { error: { code: "invalid_choice", message: `Choice must be one of ${run.approval.choices.join(", ")}` } });
      run.approval = undefined; emit(run, "approval.responded", { choice: input.choice });
      if (input.choice === "deny") { run.status = "running"; stream(run, "Okay, I left the build folder alone.", 35); }
      else { run.status = "running"; emit(run, "tool.started", { tool: "terminal", tool_call_id: `call-rm-${run.id}`, preview: "rm -rf build/" }); emit(run, "tool.completed", { tool: "terminal", tool_call_id: `call-rm-${run.id}`, preview: "removed", duration: 0.1 }); stream(run, `Cleaned the build folder (allowed ${input.choice}).`, 35); }
      return json(res, 200, { run_id: run.id, choice: input.choice ?? "deny", resolved: 1 });
    }
  }
  if (url.pathname === "/api/model/options") return json(res, 200, { model: "fixture", provider: "fixture", providers: [
    { slug: "fixture", models: ["fixture", "fixture-fast"], authenticated: true },
    { slug: "openrouter", models: ["anthropic/claude-opus-5.5", "openai/gpt-6.1"], unavailable_models: ["openai/gpt-6.1"], authenticated: true },
  ] });
  if (url.pathname === "/v1/skills") return json(res, 200, { data: [
    { name: "github", description: "Review and merge pull requests", category: "dev" },
    { name: "calendar", description: "Read and plan the day", category: "life" },
  ] });
  if (url.pathname === "/v1/toolsets") return json(res, 200, { data: [
    { name: "terminal", label: "Terminal", description: "Run shell commands", enabled: true, configured: true, tools: ["terminal", "process"] },
    { name: "browser", label: "Browser", description: "Browse the web", enabled: false, configured: false, tools: ["browse"] },
  ] });
  const modelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/model$/u);
  if (modelMatch && req.method === "POST") { const input = await body(req); console.log(`model ${modelMatch[1]} -> ${input.provider ?? ""} ${input.model}`); return json(res, 200, { runtime: { model: input.model, model_lock: "accepted" } }); }
  if (sessionMatch && req.method === "DELETE") { sessions.delete(sessionMatch[1]); messages.delete(sessionMatch[1]); return json(res, 200, { deleted: true }); }
  json(res, 404, { error: { message: "Fixture route not found" } });
});

// ---- Fake cloud inbox: just enough of cloud/src for the connector and the app ----
const iso = (offset = 0) => new Date(Date.now() - offset * 1000).toISOString();
const seedCards = () => new Map([
  ["morning-1", { id: "morning-1", rev: 1, source: "morning", key: "day", kind: "briefing", title: "Good morning", state: "open", push: "none", createdAt: iso(3600), updatedAt: iso(3600),
    body: "Three things worth your time today.", meta: { calendar: "Standup 10:00 · Dentist 15:30" },
    picks: [{ n: 1, text: "Review the Exact spike", done: false }, { n: 2, text: "Merge the connector PR", sub: "#83", url: "https://github.com/mchisolm0/apollo/pull/83", done: false }, { n: 3, text: "Reply to Scryve feedback", done: true }],
    actions: [{ id: "go", label: "Work on these", style: "primary" }, { id: "skip", label: "No picks today" }], keepOpen: true }],
  ["update-1", { id: "update-1", rev: 2, source: "preview", key: "build-412", kind: "update", title: "Scryve preview 4.12 is ready", state: "open", push: "none", createdAt: iso(7200), updatedAt: iso(7200),
    body: "Preview build **4.12** finished.\n\n- Life counter haptics\n- Faster cold start", url: "https://example.com/builds/412",
    metrics: [{ label: "cold start", value: "377", unit: "ms", delta: "−117", trend: "good" }, { label: "size", value: "41", unit: "MB", delta: "+0.4", trend: "bad" }] }],
  ["approval-1", { id: "approval-1", rev: 3, source: "fleet", key: "deploy-1", kind: "approval", title: "Deploy the landing page?", state: "open", push: "none", createdAt: iso(600), updatedAt: iso(600),
    body: "The fleet routine wants to publish the new landing page copy.", progress: { label: "Deploy", step: 2, of: 3 },
    actions: [{ id: "approve", label: "Approve", style: "primary" }, { id: "reject", label: "Reject", style: "destructive" }, { id: "edit", label: "Edit", input: "text", prefill: "" }] }],
]);
function seed() {
  sessions = seedSessions(); messages = seedMessages(); runs = new Map(); idempotency = new Map();
  cards = seedCards(); events = []; rev = 3; seq = 0;
  for (const response of [...subscribers.values()].flatMap((set) => [...set])) response.end();
  subscribers.clear();
}
seed();
const cloud = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return preflight(req, res);
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const input = req.method === "GET" ? {} : await body(req).catch(() => ({}));
  if (url.pathname === "/v1/health") return json(res, 200, { ok: true });
  if (url.pathname === "/v1/device-tokens" && req.method === "POST") return json(res, 200, { name: input.name, token: `fixture-device-${randomUUID()}` });
  if (url.pathname.startsWith("/v1/device-tokens/")) { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname === "/v1/events") return json(res, 200, events.filter((e) => e.seq > Number(url.searchParams.get("after") ?? 0) && (!url.searchParams.get("source") || e.source === url.searchParams.get("source"))));
  if (url.pathname === "/v1/cards" && req.method === "GET") return json(res, 200, { rev, cards: [...cards.values()] });
  if (url.pathname === "/v1/cards" && req.method === "POST") {
    const existing = [...cards.values()].find((c) => c.source === input.source && c.key === input.key);
    const card = { ...existing, ...input, id: existing?.id ?? randomUUID(), rev: ++rev, state: "open", push: input.push ?? "none", createdAt: existing?.createdAt ?? iso(), updatedAt: iso() };
    cards.set(card.id, card); return json(res, 200, card);
  }
  const cardMatch = url.pathname.match(/^\/v1\/cards\/([^/]+)(\/respond)?$/u);
  const card = cardMatch && cards.get(cardMatch[1]);
  if (cardMatch && !card) return json(res, 404, { error: { code: "not_found", message: "Unknown card" } });
  if (cardMatch && req.method === "PATCH") { Object.assign(card, input, { rev: ++rev, updatedAt: iso() }); return json(res, 200, card); }
  if (cardMatch?.[2]) {
    if (card.state !== "open") return json(res, 409, { error: { code: "card_closed", message: "Card is closed", card } });
    const event = { seq: ++seq, cardId: card.id, source: card.source, key: card.key, at: iso(), by: "exact-fixture" };
    if (typeof input.pick === "number") { card.picks = card.picks.map((p) => (p.n === input.pick ? { ...p, done: input.done } : p)); events.push({ ...event, type: "pick", pick: input.pick, done: input.done }); }
    else {
      events.push({ ...event, type: "action", actionId: input.actionId, ...(input.text ? { text: input.text } : {}) });
      card.resolution ??= { actionId: input.actionId, by: "exact-fixture", at: iso() };
      if (input.text) card.body = `${card.body ?? ""}\n\nYou: ${input.text}`;
      if (!card.keepOpen && card.kind !== "briefing") card.state = "resolved";
    }
    card.rev = ++rev; card.updatedAt = iso();
    return json(res, 200, card);
  }
  json(res, 404, { error: { message: "Fake cloud route not found" } });
});

await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true, mode: 0o700 });
await new Promise((resolve, reject) => hermes.listen(HERMES_PORT, HOST, (error) => error ? reject(error) : resolve()));
await new Promise((resolve, reject) => cloud.listen(CLOUD_PORT, HOST, (error) => error ? reject(error) : resolve()));
const connector = createConnectorServer({ host: HOST, port: CONNECTOR_PORT, hermesUrl: `http://${HOST}:${HERMES_PORT}`, hermesApiKey: "fixture-hermes", adminSecret: ADMIN_SECRET, statePath: join(ROOT, "connector-state.json"), label: "Exact spike fixture", cloud: { url: `http://${HOST}:${CLOUD_PORT}`, token: "fixture-connector" }, cloudPollInterval: 1000, generateThreadTitle: async (input) => `Spike: ${input.slice(0, 36)}` });
await connector.start();
const inner = `http://${HOST}:${CONNECTOR_PORT}`;
const base = `http://${HOST}:${FRONT_PORT}`;
const front = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return preflight(req, res);
  if (req.method === "POST" && req.url === "/v1/pair/exchange") {
    const input = await body(req).catch(() => ({}));
    if (input.token === "fixture") { seed(); input.token = new URLSearchParams(new URL(await pairingLink()).hash.slice(1)).get("token"); }
    const answer = await fetch(`${inner}/v1/pair/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    res.writeHead(answer.status, { ...CORS, "content-type": "application/json" });
    return res.end(await answer.text());
  }
  const out = httpRequest(`${inner}${req.url}`, { method: req.method, headers: req.headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, { ...answer.headers, ...CORS });
    answer.pipe(res);
  });
  out.on("error", () => { if (!res.headersSent) res.writeHead(502, CORS); res.end(); });
  req.pipe(out);
});
await new Promise((resolve, reject) => front.listen(FRONT_PORT, HOST, (error) => error ? reject(error) : resolve()));
async function pairingLink() {
  const pair = await (await fetch(`${inner}/admin/pair`, { method: "POST", headers: { "x-apollo-admin-secret": ADMIN_SECRET, "content-type": "application/json" }, body: JSON.stringify({ public_base_url: base, ttl_seconds: 900 }) })).json();
  return pair.pairing_url;
}

console.log(`Connector: ${base}  Fake Hermes: http://${HOST}:${HERMES_PORT}`);
console.log(`Pairing link (15 min, once): ${await pairingLink()}`);
console.log(`Another: curl -s -X POST http://${HOST}:${HERMES_PORT}/__spike/pair`);
console.log(`Reusable test link (resets the seed): apollo://pair?host=${encodeURIComponent(base)}#token=fixture`);
console.log(`Inputs: "approval" asks to run a command ("approval once only": no thread or always tier), "hold" runs until stopped or steered (a steer saying "too late" is refused, "never mind" comes back undelivered), "storm" floods 2,000 deltas.`);
process.on("SIGINT", async () => { await connector.close(); await new Promise((resolve) => hermes.close(resolve)); process.exit(0); });
