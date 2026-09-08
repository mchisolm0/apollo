import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, createConnectorServer } from "./index.mjs";

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ekho-connector-"));
  const hermes = await startHermesStub();
  const connector = createConnectorServer({ port: 0, hermesUrl: hermes.url, hermesApiKey: "hermes-secret", adminSecret: "admin-secret", statePath: join(directory, "nested", "state.json"), label: "Test Hermes", ...options });
  const address = await connector.start();
  const base = `http://127.0.0.1:${address.port}`;
  return { connector, hermes, base, statePath: join(directory, "nested", "state.json") };
}

async function startHermesStub() {
  const seen = [];
  const server = (await import("node:http")).createServer(async (req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, forwarded: req.headers["x-forwarded-for"], device: req.headers["x-ekho-device-id"] });
    if (req.url === "/v1/capabilities") return send(res, 200, { object: "hermes.api_server.capabilities", features: ["runs"] });
    if (req.url === "/v1/health") return send(res, 200, { status: "ok" });
    if (req.url === "/v1/runs/demo/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("event: run.completed\ndata: {}\n\n"); return res.end(); }
    return send(res, 200, { ok: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function send(res, status, value) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
async function req(base, path, init = {}) { const response = await fetch(`${base}${path}`, init); return { response, body: await response.json().catch(() => null) }; }
function admin(init = {}) { return { ...init, headers: { "x-ekho-admin-secret": "admin-secret", "content-type": "application/json", ...(init.headers ?? {}) } }; }

test("descriptor is public and includes live Hermes capabilities", async (t) => {
  const f = await fixture(); t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  const result = await req(f.base, "/.well-known/ekho/agent");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.label, "Test Hermes");
  assert.deepEqual(result.body.capabilities.features, ["runs"]);
  assert.equal(result.body.pairing.exchange_path, "/v1/pair/exchange");
});

test("pairing is single-use, device tokens are hashed, and revocation works", async (t) => {
  const f = await fixture(); t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  const pair = await req(f.base, "/admin/pair", admin({ method: "POST", body: JSON.stringify({ public_base_url: "https://agent.example" }) }));
  assert.equal(pair.response.status, 201);
  assert.match(pair.body.pairing_url, /^ekho:\/\/pair\?host=/u);
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


test("thread titles require device authentication and tolerate unavailable Codex", async (t) => {
  const f = await fixture({ generateThreadTitle: async (input) => input === "unavailable" ? undefined : "Count files by extension" });
  t.after(async () => { await f.connector.close(); await f.hermes.close(); });
  const submit = (input, token) => req(f.base, "/v1/ekho/thread-title", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ input }) });
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
  const path = "/v1/ekho/attachments";
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
