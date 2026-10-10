import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, createConnectorServer } from "./index.mjs";
import { createRunNotificationMonitor } from "./notifications.mjs";
import { loadCloudConfig, saveCloudConfig } from "./cloud.mjs";

test("terminal notification retries stop and stale push results preserve a newer token", async () => {
  for (const scenario of ["unroutable", "replaced-token", "push-failure"]) {
    const state = { devices: [{ id: "phone", notifications: { expo_push_token: "old", notify_on_completion: true } }] };
    let pushes = 0;
    let writes = 0;
    const monitor = createRunNotificationMonitor({
      store: { read: async () => structuredClone(state), update: async (change) => { writes++; return change(state); } },
      agentId: "agent", pollInterval: 1,
      fetchRun: async () => ({ status: "completed", session_id: scenario === "unroutable" ? null : "thread" }),
      sendPush: async () => {
        pushes++;
        if (scenario === "push-failure") throw new Error("Unavailable");
        state.devices[0].notifications.expo_push_token = "new";
        return { status: "unregistered" };
      },
    });
    try {
      await Promise.all([monitor.trackRun({ run_id: "run", status: "running" }), monitor.trackRun({ run_id: "run", status: "running" })]);
      await waitFor(() => scenario === "push-failure" ? pushes === 5 : state.notification_runs?.run?.events?.completed?.delivered.includes("phone"));
      const settledWrites = writes;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(writes, settledWrites);
      if (scenario === "replaced-token") assert.equal(state.devices[0].notifications.expo_push_token, "new");
      if (scenario === "replaced-token") assert.equal(pushes, 1);
      if (scenario === "unroutable") assert.equal(pushes, 0);
    } finally { monitor.close(); }
  }
});

test("notification history compaction retains active and undelivered runs", async () => {
  const state = { devices: [{ notifications: {} }], notification_runs: {} };
  for (let i = 0; i < 260; i++) {
    state.notification_runs[`active-${i}`] = { status: "running" };
    state.notification_runs[`done-${i}`] = { status: "completed", updated_at: new Date(i).toISOString(), events: { completed: { targets: ["phone"], delivered: ["phone"] } } };
  }
  state.notification_runs.retry = { status: "completed", events: { completed: { targets: ["phone"], delivered: [] } } };
  const monitor = createRunNotificationMonitor({ store: { read: async () => state, update: async (change) => change(state) } });
  await monitor.trackRun({ run_id: "new", status: "running" });
  assert.equal(state.notification_runs["active-0"].status, "running");
  assert.ok(state.notification_runs.retry);
  assert.equal(Object.keys(state.notification_runs).length, 262 + 256);
  await monitor.trackRun({ run_id: "__proto__", status: "running" });
  assert.equal(Object.hasOwn(state.notification_runs, "__proto__"), true);
  assert.equal(state.notification_runs.__proto__.status, "running");
  assert.equal(Object.prototype.status, undefined);
  monitor.close();
});

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "apollo-connector-"));
  const hermes = await startHermesStub();
  const connector = createConnectorServer({ port: 0, hermesUrl: hermes.url, hermesApiKey: "hermes-secret", adminSecret: "admin-secret", statePath: join(directory, "nested", "state.json"), label: "Test Hermes", cloud: null, ...options });
  const address = await connector.start();
  const base = `http://127.0.0.1:${address.port}`;
  return { connector, hermes, base, statePath: join(directory, "nested", "state.json") };
}

async function startHermesStub() {
  const seen = [];
  const runStatuses = new Map();
  const server = (await import("node:http")).createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization, cookie: req.headers.cookie, forwarded: req.headers["x-forwarded-for"], device: req.headers["x-apollo-device-id"] });
    if (req.url === "/v1/capabilities") return send(res, 200, { object: "hermes.api_server.capabilities", features: ["runs"] });
    if (req.url === "/v1/health") return send(res, 200, { status: "ok" });
    if (req.method === "POST" && req.url === "/v1/runs") return send(res, 202, { run_id: "run_test", status: "started" });
    if (req.method === "GET" && req.url === "/v1/runs/run_test") return send(res, 200, runStatuses.get("run_test") ?? { run_id: "run_test", status: "running", session_id: "session_test" });
    if (req.url === "/v1/runs/demo/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("event: run.completed\ndata: {}\n\n"); return res.end(); }
    return send(res, 200, { ok: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, seen, runStatuses, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function send(res, status, value) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
async function req(base, path, init = {}) { const response = await fetch(`${base}${path}`, init); return { response, body: await response.json().catch(() => null) }; }
function admin(init = {}) { return { ...init, headers: { "x-apollo-admin-secret": "admin-secret", "content-type": "application/json", ...(init.headers ?? {}) } }; }

test("descriptor is public and includes live Hermes capabilities", async (t) => {
  const f = await fixture(); t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  const result = await req(f.base, "/.well-known/apollo/agent");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.label, "Test Hermes");
  assert.deepEqual(result.body.capabilities.features, ["runs"]);
  assert.equal(result.body.pairing.exchange_path, "/v1/pair/exchange");
});

test("pairing is single-use, device tokens are hashed, and revocation works", async (t) => {
  const f = await fixture(); t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: JSON.stringify({ public_base_url: "https://agent.example" }) }));
  assert.equal(pair.response.status, 201);
  assert.match(pair.body.pairing_url, /^apollo:\/\/pair\?host=/u);
  const exchanged = await req(f.base, "/v1/pair/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair.body.pairing_token, device_name: "Matthew phone" }) });
  assert.equal(exchanged.response.status, 201);
  const replay = await req(f.base, "/v1/pair/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair.body.pairing_token }) });
  assert.equal(replay.response.status, 401);
  const listed = await req(f.base, "/admin/devices", admin());
  assert.equal(listed.body.devices[0].name, "Matthew phone");
  assert.equal("token_hash" in listed.body.devices[0], false);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal("access_token" in state.devices[0], false);
  assert.equal((await stat(f.statePath)).mode & 0o777, 0o600);
  const revoked = await req(f.base, `/admin/devices/${exchanged.body.device_id}/revoke`, admin({ method: "POST", body: "{}" }));
  assert.equal(revoked.response.status, 200);
  const after = await req(f.base, "/v1/health", { headers: { authorization: `Bearer ${exchanged.body.access_token}` } });
  assert.equal(after.response.status, 401);
});

test("admin API is loopback-authenticated and proxy strips sensitive caller headers", async (t) => {
  const f = await fixture(); t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  const forbidden = await req(f.base, "/admin/devices");
  assert.equal(forbidden.response.status, 403);
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
  const exchanged = await req(f.base, "/v1/pair/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair.body.pairing_token }) });
  const result = await req(f.base, "/v1/health", { headers: { authorization: `Bearer ${exchanged.body.access_token}`, cookie: "steal=me", "x-forwarded-for": "attacker", "x-hermes-session-id": "session-1" } });
  assert.equal(result.response.status, 200);
  assert.equal(f.hermes.seen.at(-1).authorization, "Bearer hermes-secret");
  assert.equal(f.hermes.seen.at(-1).cookie, undefined);
  assert.equal(f.hermes.seen.at(-1).forwarded, undefined);
  assert.equal(f.hermes.seen.at(-1).device.length > 0, true);
  const blocked = await req(f.base, "/v1/browser-control/ws", { headers: { authorization: `Bearer ${exchanged.body.access_token}` } });
  assert.equal(blocked.response.status, 404);
});

test("allowlisted SSE route is streamed", async (t) => {
  const f = await fixture(); t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
  const exchanged = await req(f.base, "/v1/pair/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair.body.pairing_token }) });
  const response = await fetch(`${f.base}/v1/runs/demo/events`, { headers: { authorization: `Bearer ${exchanged.body.access_token}`, accept: "text/event-stream" } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /run\.completed/u);
});

test("model inventory is device-authenticated and GET-only", async (t) => {
  const f = await fixture(); t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  assert.equal((await req(f.base, "/api/model/options")).response.status, 401);
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
  const exchange = await req(f.base, "/v1/pair/exchange", { method: "POST", body: JSON.stringify({ token: pair.body.pairing_token }) });
  const headers = { authorization: `Bearer ${exchange.body.access_token}` };
  assert.equal((await req(f.base, "/api/model/options", { headers })).response.status, 200);
  assert.equal(f.hermes.seen.at(-1).url, "/api/model/options");
  const count = f.hermes.seen.length;
  for (const method of ["POST", "PATCH", "DELETE"]) {
    assert.equal((await req(f.base, "/api/model/options", { method, headers })).response.status, 404);
  }
  assert.equal(f.hermes.seen.length, count);
});


test("thread titles require device authentication and tolerate unavailable Codex", async (t) => {
  const f = await fixture({ generateThreadTitle: async (input) => input === "unavailable" ? undefined : "Count files by extension" });
  t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  const submit = (input, token) => req(f.base, "/v1/apollo/thread-title", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ input }) });
  assert.equal((await submit("Count files")).response.status, 401);
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
  const exchange = await req(f.base, "/v1/pair/exchange", { method: "POST", body: JSON.stringify({ token: pair.body.pairing_token }) });
  const token = exchange.body.access_token;
  assert.equal((await submit("Count files", token)).body.title, "Count files by extension");
  assert.equal((await submit("unavailable", token)).body.title, null);
  assert.equal((await submit("", token)).response.status, 400);
});

test("attachments preserve bytes privately and require an active device token", async (t) => {
  const f = await fixture();
  t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  const path = "/v1/apollo/attachments";
  const bytes = Buffer.from([0, 255, 127, 10, 65]);
  const body = JSON.stringify({ name: "../../metadata.json", mimeType: "application/octet-stream", data: bytes.toString("base64") });
  assert.equal((await req(f.base, path, { method: "POST", body })).response.status, 401);
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
  const exchange = await req(f.base, "/v1/pair/exchange", { method: "POST", body: JSON.stringify({ token: pair.body.pairing_token }) });
  const headers = { authorization: `Bearer ${exchange.body.access_token}`, "content-type": "application/json" };
  const uploaded = await req(f.base, path, { method: "POST", headers, body });
  assert.equal(uploaded.response.status, 201);
  const file = uploaded.body.attachment;
  assert.equal(file.name.includes("/"), false);
  assert.equal(file.size, bytes.length);
  assert.deepEqual(await readFile(file.path), bytes);
  assert.equal((await stat(file.path)).mode & 0o777, 0o600);
  assert.equal((await req(f.base, `${path}/${file.id}`)).response.status, 401);
  const downloaded = await fetch(`${f.base}${path}/${file.id}`, { headers });
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.equal(downloaded.headers.get("cache-control"), "private, no-store");
  assert.equal(downloaded.headers.get("content-disposition"), "attachment");
  const invalid = await req(f.base, path, { method: "POST", headers, body: JSON.stringify({ name: "bad.txt", mimeType: "text/plain", data: "not base64" }) });
  assert.equal(invalid.response.status, 400);
  await req(f.base, `/admin/devices/${exchange.body.device_id}/revoke`, admin({ method: "POST", body: "{}" }));
  assert.equal((await req(f.base, `${path}/${file.id}`, { headers })).response.status, 401);
  assert.equal((await req(f.base, path, { method: "POST", headers, body })).response.status, 401);
});

test("settled threads survive a new device and restart; migration cannot undo reopen", async (t) => {
  const f = await fixture(); t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  async function device() {
    const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
    const exchange = await req(f.base, "/v1/pair/exchange", { method: "POST", body: JSON.stringify({ token: pair.body.pairing_token }) });
    return { authorization: `Bearer ${exchange.body.access_token}`, "content-type": "application/json" };
  }
  const first = await device();
  const patch = (headers, settled, importOnly = false) => req(f.base, "/v1/inbox", { method: "PATCH", headers, body: JSON.stringify({ settled, importOnly }) });
  assert.equal((await patch({}, { thread: 20 })).response.status, 401);
  assert.equal((await patch(first, { thread: 20 })).response.status, 200);
  const second = await device();
  assert.deepEqual((await req(f.base, "/v1/inbox", { headers: second })).body.settled, { thread: 20 });
  const reloaded = new StateStore(f.statePath, "Test");
  assert.deepEqual((await reloaded.load()).inbox_settled, { thread: 20 });
  await patch(second, { thread: null });
  await patch(first, { thread: 20, older: 10 }, true);
  assert.deepEqual((await req(f.base, "/v1/inbox", { headers: second })).body.settled, { thread: null, older: 10 });
  assert.equal((await patch(first, { broken: -1 })).response.status, 400);
  assert.equal((await patch(first, { broken: "20" })).response.status, 400);
});

test("inbox config stores per-session auto-settle opt-outs and rejects malformed config", async (t) => {
  const f = await fixture(); t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  async function device() {
    const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
    const exchange = await req(f.base, "/v1/pair/exchange", { method: "POST", body: JSON.stringify({ token: pair.body.pairing_token }) });
    return { authorization: `Bearer ${exchange.body.access_token}`, "content-type": "application/json" };
  }
  const first = await device();
  const patch = (headers, body) => req(f.base, "/v1/inbox", { method: "PATCH", headers, body: JSON.stringify(body) });
  assert.equal((await patch(first, { settled: {}, config: { thread: { auto_settle: false } } })).response.status, 200);
  const second = await device();
  assert.deepEqual((await req(f.base, "/v1/inbox", { headers: second })).body.config, { thread: { auto_settle: false } });
  await patch(second, { settled: {}, config: { thread: { auto_settle: true } } });
  assert.deepEqual((await req(f.base, "/v1/inbox", { headers: first })).body.config, { thread: { auto_settle: true } });
  const reloaded = new StateStore(f.statePath, "Test");
  await reloaded.load();
  assert.deepEqual((await reloaded.load()).inbox_config, { thread: { auto_settle: true } });
  for (const config of [
    { thread: false },
    { thread: { auto_settle: "off" } },
    { thread: { other: true } },
    { thread: { auto_settle: false, extra: 1 } },
    { "bad/id": { auto_settle: false } },
    { constructor: { auto_settle: false } },
    "not-an-object",
  ]) {
    assert.equal((await patch(first, { settled: {}, config })).response.status, 400);
  }
});

test("notification registration is device-authenticated and validates its boundary", async (t) => {
  const f = await fixture({ sendPush: async () => ({ status: "ok" }) }); t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  const path = "/v1/apollo/notifications";
  assert.equal((await req(f.base, path)).response.status, 401);
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
  const exchange = await req(f.base, "/v1/pair/exchange", { method: "POST", body: JSON.stringify({ token: pair.body.pairing_token }) });
  const headers = { authorization: `Bearer ${exchange.body.access_token}`, "content-type": "application/json" };
  const put = (body) => req(f.base, path, { method: "PUT", headers, body: JSON.stringify(body) });
  assert.equal((await put({ expo_push_token: "nope" })).response.status, 400);
  assert.equal((await put({ expo_push_token: "ExpoPushToken[valid_123]", notify_on_failure: "yes" })).response.status, 400);
  assert.equal((await put({ expo_push_token: "ExpoPushToken[valid_123]", secret: true })).response.status, 400);
  assert.equal((await put({ expo_push_token: "ExpoPushToken[valid_123]", notify_on_approval: false })).response.status, 200);
  assert.deepEqual((await req(f.base, path, { headers })).body, { registered: true, notify_on_approval: false, notify_on_completion: true, notify_on_failure: true });
  const devices = await req(f.base, "/admin/devices", admin());
  assert.equal(JSON.stringify(devices.body).includes("valid_123"), false);
  assert.equal(devices.body.devices[0].notifications_registered, true);
  assert.equal((await req(f.base, path, { method: "DELETE", headers })).body.registered, false);
  assert.equal((await req(f.base, path, { headers })).body.registered, false);
  await put({ expo_push_token: "ExpoPushToken[valid_123]" });
  await req(f.base, `/admin/devices/${exchange.body.device_id}/revoke`, admin({ method: "POST", body: "{}" }));
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal("notifications" in state.devices[0], false);
  assert.equal((await req(f.base, path, { headers })).response.status, 401);
});

test("run notifications are deduplicated and invalid push tokens are removed", async (t) => {
  const sent = [];
  let approvalAttempts = 0;
  const sendPush = async (pushToken, notification) => {
    if (notification.data.kind === "approval" && approvalAttempts++ === 0) throw new Error("temporary outage");
    sent.push({ pushToken, notification });
    return notification.data.kind === "completed" ? { status: "unregistered" } : { status: "ok" };
  };
  const f = await fixture({ sendPush, notificationPollInterval: 5 });
  t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
  const exchange = await req(f.base, "/v1/pair/exchange", { method: "POST", body: JSON.stringify({ token: pair.body.pairing_token }) });
  const headers = { authorization: `Bearer ${exchange.body.access_token}`, "content-type": "application/json" };
  await req(f.base, "/v1/apollo/notifications", { method: "PUT", headers, body: JSON.stringify({ expo_push_token: "ExpoPushToken[device_123]" }) });
  f.hermes.runStatuses.set("run_test", { run_id: "run_test", status: "waiting_for_approval", session_id: "session_test", updated_at: 10, approval: { request_id: "approval_1", command: "private command" } });
  assert.equal((await req(f.base, "/v1/runs", { method: "POST", headers, body: JSON.stringify({ input: "private input", session_id: "session_test" }) })).response.status, 202);
  await waitFor(() => sent.length === 1);
  assert.equal(approvalAttempts, 2);
  assert.equal(sent[0].notification.data.kind, "approval");
  assert.equal(JSON.stringify(sent[0].notification).includes("private"), false);
  await req(f.base, "/v1/runs", { method: "POST", headers, body: JSON.stringify({ input: "private input", session_id: "session_test" }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 1);
  f.hermes.runStatuses.set("run_test", { run_id: "run_test", status: "completed", session_id: "session_test", updated_at: 20, output: "private output" });
  await waitFor(() => sent.length === 2);
  assert.equal(sent[1].notification.data.kind, "completed");
  await waitFor(async () => (await req(f.base, "/v1/apollo/notifications", { headers })).body.registered === false);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.deepEqual(state.notification_runs.run_test.events.completed.delivered, [exchange.body.device_id]);
  assert.equal(JSON.stringify(state.notification_runs).includes("private"), false);
});

test("run status is not polled without a notification subscriber", async (t) => {
  const f = await fixture({ sendPush: async () => ({ status: "ok" }), notificationPollInterval: 5 });
  t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
  const exchange = await req(f.base, "/v1/pair/exchange", { method: "POST", body: JSON.stringify({ token: pair.body.pairing_token }) });
  const headers = { authorization: `Bearer ${exchange.body.access_token}`, "content-type": "application/json" };
  await req(f.base, "/v1/runs", { method: "POST", headers, body: JSON.stringify({ input: "private input", session_id: "session_test" }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.hermes.seen.some((request) => request.method === "GET" && request.url === "/v1/runs/run_test"), false);
  assert.equal((await f.connector.store.read()).notification_runs, undefined);
});

async function waitFor(predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not met before timeout");
}

async function startCloudStub() {
  const seen = [];
  const events = [];
  const stub = { seen, events, fail: false };
  const server = (await import("node:http")).createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    if (stub.fail) return send(res, 500, { error: { code: "down", message: "down" } });
    const url = new URL(req.url, "http://cloud");
    if (req.method === "POST" && url.pathname === "/v1/device-tokens") return send(res, 200, { token: `cloud-${seen.length}`, name: body.name });
    if (req.method === "DELETE" && url.pathname.startsWith("/v1/device-tokens/")) { res.writeHead(204); return res.end(); }
    if (req.method === "POST" && url.pathname === "/v1/cards") return send(res, 200, { ...body, id: `card:${body.key}`, state: "open" });
    if (req.method === "PATCH") return send(res, 200, { id: decodeURIComponent(url.pathname.split("/").at(-1)), ...body });
    if (req.method === "GET" && url.pathname === "/v1/events") return send(res, 200, events.filter((event) => event.seq > Number(url.searchParams.get("after"))));
    return send(res, 404, { error: { code: "not_found", message: "not found" } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(stub, { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) });
}

async function cloudFixture(options = {}) {
  const cloud = await startCloudStub();
  const f = await fixture({ cloud: { url: cloud.url, token: "connector-secret" }, notificationPollInterval: 5, cloudPollInterval: 5, ...options });
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
  const exchange = await req(f.base, "/v1/pair/exchange", { method: "POST", body: JSON.stringify({ token: pair.body.pairing_token }) });
  const headers = { authorization: `Bearer ${exchange.body.access_token}`, "content-type": "application/json" };
  const close = async () => { await f.connector.close(); await f.hermes.close(); await cloud.close(); };
  return { ...f, cloud, exchange, headers, close };
}

test("pairing returns cloud credentials named after the device and survives a cloud outage", async (t) => {
  const f = await cloudFixture(); t.after(f.close);
  assert.deepEqual(f.exchange.body.cloud, { url: f.cloud.url, token: "cloud-1" });
  assert.deepEqual(f.cloud.seen[0], { method: "POST", url: "/v1/device-tokens", authorization: "Bearer connector-secret", body: { name: f.exchange.body.device_id } });
  assert.equal(JSON.stringify(JSON.parse(await readFile(f.statePath, "utf8"))).includes("cloud-1"), false);
  const refreshed = await req(f.base, "/v1/apollo/cloud-token", { method: "POST", headers: f.headers });
  assert.deepEqual(refreshed.body.cloud, { url: f.cloud.url, token: "cloud-2" });
  assert.equal((await req(f.base, "/v1/apollo/cloud-token", { method: "POST" })).response.status, 401);
  f.cloud.fail = true;
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
  const offline = await req(f.base, "/v1/pair/exchange", { method: "POST", body: JSON.stringify({ token: pair.body.pairing_token }) });
  assert.equal(offline.response.status, 201);
  assert.equal("cloud" in offline.body, false);
  f.cloud.fail = false;
  await req(f.base, `/admin/devices/${f.exchange.body.device_id}/revoke`, admin({ method: "POST", body: "{}" }));
  assert.equal(f.cloud.seen.at(-1).method, "DELETE");
  assert.equal(f.cloud.seen.at(-1).url, `/v1/device-tokens/${f.exchange.body.device_id}`);
});

test("a Hermes approval becomes a cloud card and an approve event answers Hermes once", async (t) => {
  const pushes = [];
  const f = await cloudFixture({ sendPush: async (_token, notification) => { pushes.push(notification.data.kind); return { status: "ok" }; } });
  t.after(f.close);
  await req(f.base, "/v1/apollo/notifications", { method: "PUT", headers: f.headers, body: JSON.stringify({ expo_push_token: "ExpoPushToken[device_123]" }) });
  f.hermes.runStatuses.set("run_test", { run_id: "run_test", status: "waiting_for_approval", session_id: "session_test", approval: { request_id: "req_1", command: "rm -rf build", description: "recursive delete" } });
  await req(f.base, "/v1/runs", { method: "POST", headers: f.headers, body: JSON.stringify({ input: "clean", session_id: "session_test" }) });
  await waitFor(() => f.cloud.seen.some((request) => request.url === "/v1/cards"));
  const { agent_id: agentId } = await f.connector.store.read();
  const card = f.cloud.seen.find((request) => request.url === "/v1/cards").body;
  assert.ok(Date.parse(card.expiresAt) > Date.now());
  assert.deepEqual(card, {
    source: "hermes", key: "run_test:req_1", kind: "approval", title: "Allow this command?", body: "recursive delete\n\nrm -rf build",
    url: `apollo://session/session_test?agentId=${agentId}&runId=run_test`, expiresAt: card.expiresAt,
    actions: [{ id: "approve", label: "Approve", style: "primary" }, { id: "reject", label: "Reject", style: "destructive" }],
  });
  f.cloud.events.push({ seq: 7, cardId: "card:run_test:req_1", source: "hermes", key: "run_test:req_1", at: new Date().toISOString(), by: "phone", type: "action", actionId: "approve" });
  await waitFor(() => f.hermes.seen.some((request) => request.method === "POST" && request.url === "/v1/runs/run_test/approval"));
  assert.deepEqual(JSON.parse(f.hermes.seen.find((request) => request.url === "/v1/runs/run_test/approval").body), { choice: "once", request_id: "req_1" });
  await waitFor(async () => (await f.connector.store.read()).cloud_events_after === 7);
  f.hermes.runStatuses.set("run_test", { run_id: "run_test", status: "completed", session_id: "session_test" });
  await waitFor(() => pushes.includes("completed"));
  assert.deepEqual(pushes, ["completed"]);
  assert.deepEqual((await f.connector.store.read()).cloud_approvals, {});
});

test("a cloud outage falls back to the direct approval push and the card still arrives later", async (t) => {
  const pushes = [];
  const f = await cloudFixture({ cloudFallbackAfter: 30, sendPush: async (_token, notification) => { pushes.push(notification.data.kind); return { status: "ok" }; } });
  t.after(f.close);
  await req(f.base, "/v1/apollo/notifications", { method: "PUT", headers: f.headers, body: JSON.stringify({ expo_push_token: "ExpoPushToken[device_123]" }) });
  f.cloud.fail = true;
  f.hermes.runStatuses.set("run_test", { run_id: "run_test", status: "waiting_for_approval", session_id: "session_test", approval: { request_id: "req_1", command: "git push" } });
  await req(f.base, "/v1/runs", { method: "POST", headers: f.headers, body: JSON.stringify({ input: "ship", session_id: "session_test" }) });
  await waitFor(() => pushes.includes("approval"));
  assert.ok(f.cloud.seen.filter((request) => request.url === "/v1/cards").length > 1);
  f.cloud.fail = false;
  await waitFor(async () => (await f.connector.store.read()).cloud_approvals?.["run_test:req_1"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(pushes, ["approval"]);
});

test("an approval answered in the app thread resolves its cloud card", async (t) => {
  const f = await cloudFixture(); t.after(f.close);
  f.hermes.runStatuses.set("run_test", { run_id: "run_test", status: "waiting_for_approval", session_id: "session_test", approval: { request_id: "req_1", command: "git push", tool: "terminal" } });
  await req(f.base, "/v1/runs", { method: "POST", headers: f.headers, body: JSON.stringify({ input: "ship", session_id: "session_test" }) });
  await waitFor(() => f.cloud.seen.some((request) => request.url === "/v1/cards"));
  assert.equal(f.cloud.seen.find((request) => request.url === "/v1/cards").body.title, "Allow terminal?");
  f.hermes.runStatuses.set("run_test", { run_id: "run_test", status: "running", session_id: "session_test" });
  await waitFor(() => f.cloud.seen.some((request) => request.method === "PATCH"));
  assert.deepEqual(f.cloud.seen.find((request) => request.method === "PATCH"), { method: "PATCH", url: `/v1/cards/${encodeURIComponent("card:run_test:req_1")}`, authorization: "Bearer connector-secret", body: { state: "resolved" } });
  assert.equal(f.hermes.seen.some((request) => request.url === "/v1/runs/run_test/approval"), false);
});

test("cloud config is a 0600 file that env overrides, and needs HTTPS", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "apollo-cloud-")), "cloud.json");
  assert.equal(await loadCloudConfig({ path, env: {} }), null);
  await saveCloudConfig(path, { url: "https://inbox.example/", token: "file-token" });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await loadCloudConfig({ path, env: {} }), { url: "https://inbox.example", token: "file-token" });
  assert.deepEqual(await loadCloudConfig({ path, env: { APOLLO_CLOUD_TOKEN: "env-token" } }), { url: "https://inbox.example", token: "env-token" });
  await assert.rejects(saveCloudConfig(path, { url: "http://inbox.example", token: "x" }), /HTTPS/u);
});

test("without cloud config pairing and approvals are unchanged", async (t) => {
  const f = await fixture({ cloud: null }); t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  assert.equal((await req(f.base, "/.well-known/apollo/agent")).body.cloud.available, false);
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: "{}" }));
  const exchange = await req(f.base, "/v1/pair/exchange", { method: "POST", body: JSON.stringify({ token: pair.body.pairing_token }) });
  assert.equal("cloud" in exchange.body, false);
  const headers = { authorization: `Bearer ${exchange.body.access_token}` };
  assert.equal((await req(f.base, "/v1/apollo/cloud-token", { method: "POST", headers })).response.status, 503);
});
