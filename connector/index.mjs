import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir, hostname } from "node:os";
import http from "node:http";
import { isIP } from "node:net";

const execFileAsync = promisify(execFile);
const VERSION = "0.1.0";
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const PUBLIC_DESCRIPTOR_PATH = "/.well-known/ekho/agent";
const EXCHANGE_PATH = "/v1/pair/exchange";

const PROXY_ROUTES = new Set([
  "GET /v1/health", "GET /v1/models", "GET /v1/capabilities", "GET /v1/skills", "GET /v1/toolsets",
  "POST /v1/chat/completions", "POST /v1/responses", "GET /v1/responses/:id", "DELETE /v1/responses/:id",
  "POST /v1/runs", "GET /v1/runs/:id", "GET /v1/runs/:id/events", "POST /v1/runs/:id/approval",
  "POST /v1/runs/:id/steer", "POST /v1/runs/:id/stop",
  "GET /api/sessions", "POST /api/sessions", "GET /api/sessions/:id", "PATCH /api/sessions/:id",
  "DELETE /api/sessions/:id", "GET /api/sessions/:id/messages", "POST /api/sessions/:id/fork",
  "POST /api/sessions/:id/chat", "POST /api/sessions/:id/chat/stream", "POST /api/sessions/:id/model",
]);

const json = (res, status, body, headers = {}) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(data);
};

const error = (res, status, message, code = "error") => json(res, status, { error: { code, message } });

const hash = (value) => createHash("sha256").update(value).digest("hex");
const secureEqual = (a, b) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const token = () => randomBytes(32).toString("base64url");
const isoNow = () => new Date().toISOString();
const defaultStatePath = () => `${homedir()}/.config/ekho/connector.json`;

function freshState(label) {
  return { version: 1, agent_id: randomUUID(), label, created_at: isoNow(), pairing_tokens: [], devices: [] };
}

export class StateStore {
  #path;
  #state;
  #queue = Promise.resolve();

  constructor(path, label) {
    this.#path = path;
    this.#state = freshState(label);
  }

  async load() {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700);
    try {
      this.#state = JSON.parse(await readFile(this.#path, "utf8"));
      if (!this.#state || this.#state.version !== 1 || !Array.isArray(this.#state.pairing_tokens) || !Array.isArray(this.#state.devices)) throw new Error("unsupported state shape");
      await chmod(this.#path, 0o600);
    } catch (cause) {
      if (cause.code !== "ENOENT") throw new Error(`Invalid connector state at ${this.#path}: ${cause.message}`);
      await this.#write();
    }
    return this.#state;
  }

  async read() {
    await this.#queue;
    return this.#state;
  }

  async update(mutator) {
    const previous = this.#queue;
    let release;
    this.#queue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const result = await mutator(this.#state);
      await this.#write();
      return result;
    } finally {
      release();
    }
  }

  async #write() {
    const temporary = `${this.#path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
  }
}

function validProxyRoute(method, pathname) {
  const exact = `${method} ${pathname}`;
  if (PROXY_ROUTES.has(exact)) return true;
  const id = "[A-Za-z0-9._~-]+";
  return (
    new RegExp(`^GET /v1/responses/${id}$`, "u").test(exact) && method === "GET" ||
    new RegExp(`^DELETE /v1/responses/${id}$`, "u").test(exact) && method === "DELETE" ||
    new RegExp(`^GET /v1/runs/${id}(?:/events)?$`, "u").test(exact) && method === "GET" ||
    new RegExp(`^POST /v1/runs/${id}/(?:approval|steer|stop)$`, "u").test(exact) && method === "POST" ||
    new RegExp(`^(?:GET|PATCH|DELETE) /api/sessions/${id}$`, "u").test(exact) && ["GET", "PATCH", "DELETE"].includes(method) ||
    new RegExp(`^GET /api/sessions/${id}/messages$`, "u").test(exact) && method === "GET" ||
    new RegExp(`^POST /api/sessions/${id}/(?:fork|chat|chat/stream|model)$`, "u").test(exact) && method === "POST"
  );
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readBody(req, max = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(body) {
  try { return body.length ? JSON.parse(body.toString("utf8")) : {}; }
  catch { throw Object.assign(new Error("request body must be valid JSON"), { status: 400 }); }
}

function bearer(headers) {
  const value = headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7).trim() : null;
}

function forwardedHeaders(req) {
  const headers = {};
  for (const name of ["accept", "content-type", "idempotency-key", "x-hermes-session-id", "x-hermes-session-key", "user-agent"]) {
    const value = req.headers[name];
    if (value) headers[name] = value;
  }
  return headers;
}

function normalizeName(name) {
  if (typeof name !== "string" || !name.trim()) return "Ekho mobile";
  return name.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 80) || "Ekho mobile";
}

function isLoopbackHost(value) {
  const host = value.toLowerCase().replace(/^\[|\]$/gu, "");
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || (isIP(host) === 4 && host.startsWith("127."));
}

async function discoverCapabilities(hermesUrl, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(new URL("/v1/capabilities", hermesUrl), {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, redirect: "error", signal: controller.signal,
    });
    if (response.ok) return await response.json();
  } catch { /* The descriptor remains useful while Hermes is starting. */ }
  finally { clearTimeout(timeout); }
  return null;
}

export function createConnectorServer(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8643;
  const hermesUrl = new URL(options.hermesUrl ?? process.env.HERMES_URL ?? "http://127.0.0.1:8642");
  if (!/^https?:$/u.test(hermesUrl.protocol) || hermesUrl.username || hermesUrl.password) throw new Error("HERMES_URL must be a plain HTTP(S) URL");
  if (!isLoopbackHost(hermesUrl.hostname)) throw new Error("HERMES_URL must point to a loopback Hermes API");
  const hermesApiKey = options.hermesApiKey ?? process.env.HERMES_API_KEY;
  const adminSecret = options.adminSecret ?? process.env.EKHO_ADMIN_SECRET;
  if (!hermesApiKey) throw new Error("HERMES_API_KEY is required");
  if (!adminSecret) throw new Error("EKHO_ADMIN_SECRET is required");
  const label = options.label ?? process.env.EKHO_AGENT_LABEL ?? hostname();
  const store = options.store ?? new StateStore(options.statePath ?? process.env.EKHO_STATE_FILE ?? defaultStatePath(), label);

  async function authenticateDevice(req) {
    const presented = bearer(req.headers);
    if (!presented) return null;
    const presentedHash = hash(presented);
    return store.update((state) => {
      const device = state.devices.find((candidate) => !candidate.revoked_at && secureEqual(candidate.token_hash, presentedHash));
      if (!device) return null;
      device.last_used_at = isoNow();
      return { id: device.id, name: device.name };
    });
  }

  function authenticateAdmin(req) {
    const presented = req.headers["x-ekho-admin-secret"] ?? bearer(req.headers);
    return typeof presented === "string" && secureEqual(presented, adminSecret);
  }

  async function descriptor() {
    const state = await store.read();
    const capabilities = await discoverCapabilities(hermesUrl, hermesApiKey);
    return {
      object: "ekho.agent",
      agent_id: state.agent_id,
      label: state.label,
      hostname: hostname(),
      connector_version: VERSION,
      proxy_base_url: "/",
      capabilities,
      auth_methods: ["pairing_token"],
      pairing: { exchange_path: EXCHANGE_PATH, url_scheme: "ekho", fragment_token: true },
      ...(options.publicBaseUrl ? { public_base_url: options.publicBaseUrl } : {}),
    };
  }

  async function handleAdmin(req, res, url) {
    if (!isLoopback(req.socket.remoteAddress) || !authenticateAdmin(req)) return error(res, 403, "local admin authentication required", "admin_forbidden");
    if (req.method === "POST" && url.pathname === "/admin/pair") {
      const body = parseJson(await readBody(req, 64 * 1024));
      const requestedTtl = Number(body.ttl_seconds ?? 300);
      if (!Number.isFinite(requestedTtl) || requestedTtl < 1) return error(res, 400, "ttl_seconds must be a positive number", "invalid_ttl");
      const ttl = Math.min(Math.max(Math.floor(requestedTtl), 30), 900);
      const raw = token();
      const expires = new Date(Date.now() + ttl * 1000).toISOString();
      const state = await store.update((current) => {
        current.pairing_tokens = current.pairing_tokens.filter((candidate) => Date.parse(candidate.expires_at) > Date.now());
        current.pairing_tokens.push({ token_hash: hash(raw), device_name: normalizeName(body.device_name), created_at: isoNow(), expires_at: expires });
        return current;
      });
      const publicBase = typeof body.public_base_url === "string" ? body.public_base_url : options.publicBaseUrl;
      const pairingUrl = publicBase ? `ekho://pair?host=${encodeURIComponent(publicBase)}#token=${raw}` : null;
      return json(res, 201, { agent_id: state.agent_id, pairing_token: raw, expires_at: expires, pairing_url: pairingUrl });
    }
    if (req.method === "GET" && url.pathname === "/admin/devices") {
      const state = await store.read();
      return json(res, 200, { devices: state.devices.map(({ token_hash, ...device }) => device) });
    }
    const revoke = url.pathname.match(/^\/admin\/devices\/([A-Za-z0-9._~-]+)\/revoke$/u);
    if (req.method === "POST" && revoke) {
      const device = await store.update((state) => {
        const found = state.devices.find((candidate) => candidate.id === revoke[1]);
        if (found && !found.revoked_at) found.revoked_at = isoNow();
        return found;
      });
      return device ? json(res, 200, { device_id: device.id, revoked_at: device.revoked_at }) : error(res, 404, "device not found", "not_found");
    }
    return error(res, 404, "admin route not found", "not_found");
  }

  async function exchange(req, res) {
    let body;
    try { body = parseJson(await readBody(req, 64 * 1024)); } catch (cause) { return error(res, cause.status ?? 400, cause.message); }
    const raw = typeof body.token === "string" ? body.token.trim() : "";
    if (!raw) return error(res, 400, "pairing token is required", "invalid_pairing_token");
    const result = await store.update((state) => {
      const now = Date.now();
      state.pairing_tokens = state.pairing_tokens.filter((candidate) => Date.parse(candidate.expires_at) > now);
      const index = state.pairing_tokens.findIndex((candidate) => secureEqual(candidate.token_hash, hash(raw)));
      if (index < 0) return null;
      const pairing = state.pairing_tokens.splice(index, 1)[0];
      const accessToken = token();
      const device = { id: randomUUID(), name: normalizeName(body.device_name ?? pairing.device_name), token_hash: hash(accessToken), scopes: ["owner"], created_at: isoNow(), last_used_at: null, revoked_at: null };
      state.devices.push(device);
      return { device, accessToken };
    });
    if (!result) return error(res, 401, "pairing token is invalid or expired", "invalid_pairing_token");
    return json(res, 201, { device_id: result.device.id, device_name: result.device.name, access_token: result.accessToken, token_type: "Bearer", scopes: result.device.scopes });
  }

  async function proxy(req, res, url) {
    if (!validProxyRoute(req.method, url.pathname)) return error(res, 404, "route not available through Ekho", "not_found");
    const device = await authenticateDevice(req);
    if (!device) return error(res, 401, "device authentication required", "unauthorized");
    let body;
    try { body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req); }
    catch (cause) { return error(res, cause.status ?? 400, cause.message); }
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    const headers = forwardedHeaders(req);
    headers.authorization = `Bearer ${hermesApiKey}`;
    headers["x-ekho-device-id"] = device.id;
    let upstream;
    try {
      upstream = await fetch(new URL(`${url.pathname}${url.search}`, hermesUrl), { method: req.method, headers, body, redirect: "error", signal: controller.signal });
    } catch (cause) {
      if (res.headersSent) return;
      return error(res, 502, `Hermes is unreachable: ${cause.message}`, "hermes_unreachable");
    }
    const responseHeaders = {};
    for (const name of ["content-type", "cache-control", "etag", "last-modified", "location", "retry-after"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) return res.end();
    try { for await (const chunk of upstream.body) res.write(chunk); } catch { /* client disconnect */ }
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === PUBLIC_DESCRIPTOR_PATH) return json(res, 200, await descriptor());
      if (req.method === "POST" && url.pathname === EXCHANGE_PATH) return exchange(req, res);
      if (url.pathname.startsWith("/admin/")) return handleAdmin(req, res, url);
      return proxy(req, res, url);
    } catch (cause) {
      if (!res.headersSent) error(res, cause.status ?? 500, cause.message ?? "internal connector error", "internal_error");
    }
  });

  return {
    server,
    store,
    async start() { await store.load(); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }); return server.address(); },
    async close() { await new Promise((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve())); },
  };
}

export async function tailscaleStatus() {
  const { stdout } = await execFileAsync("tailscale", ["status", "--json"], { maxBuffer: 2 * 1024 * 1024 });
  const status = JSON.parse(stdout);
  const dnsName = typeof status.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/u, "") : null;
  if (!dnsName) throw new Error("Tailscale has no MagicDNS name; run `tailscale up` and enable MagicDNS");
  return { dnsName, status };
}

export async function configureTailscaleServe(localPort, servePort = 8443) {
  await execFileAsync("tailscale", ["serve", "--bg", `--https=${servePort}`, `http://127.0.0.1:${localPort}`]);
}

export { EXCHANGE_PATH, PUBLIC_DESCRIPTOR_PATH, PROXY_ROUTES, defaultStatePath, validProxyRoute };
