import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnectorServer } from "./index.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ekho-connector-"));
  const hermes = await startHermesStub();
  const connector = createConnectorServer({ port: 0, hermesUrl: hermes.url, hermesApiKey: "hermes-secret", adminSecret: "admin-secret", statePath: join(directory, "nested", "state.json"), label: "Test Hermes" });
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
