import { saveAttachment, readAttachment, MAX_UPLOAD_BODY_BYTES } from './attachments.mjs';
import { generateThreadTitle } from './thread-title.mjs';
import { createExpoPushSender, createRunNotificationMonitor, parseNotificationRegistration } from './notifications.mjs';
import { createApprovalBridge, createCloudClient, loadCloudConfig } from './cloud.mjs';
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
const PUBLIC_DESCRIPTOR_PATH = "/.well-known/apollo/agent";
const EXCHANGE_PATH = "/v1/pair/exchange";

const PROXY_ROUTES = new Set([
  "GET /v1/health", "GET /v1/models", "GET /v1/capabilities", "GET /v1/skills", "GET /v1/toolsets",
  "GET /api/model/options",
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
const defaultStatePath = () => `${homedir()}/.config/apollo/connector.json`;
const defaultCloudPath = (statePath = process.env.APOLLO_STATE_FILE ?? defaultStatePath()) => process.env.APOLLO_CLOUD_FILE ?? `${dirname(statePath)}/cloud.json`;

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
  if (typeof name !== "string" || !name.trim()) return "Apollo mobile";
  return name.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 80) || "Apollo mobile";
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
  const adminSecret = options.adminSecret ?? process.env.APOLLO_ADMIN_SECRET;
  if (!hermesApiKey) throw new Error("HERMES_API_KEY is required");
  if (!adminSecret) throw new Error("APOLLO_ADMIN_SECRET is required");
  const label = options.label ?? process.env.APOLLO_AGENT_LABEL ?? hostname();
  const store = options.store ?? new StateStore(options.statePath ?? process.env.APOLLO_STATE_FILE ?? defaultStatePath(), label);
  const expoPushUrl = options.expoPushUrl ?? process.env.APOLLO_EXPO_PUSH_URL;
  const sendPush = options.sendPush ?? (expoPushUrl ? createExpoPushSender({
    url: expoPushUrl,
    accessToken: options.expoAccessToken ?? process.env.APOLLO_EXPO_ACCESS_TOKEN,
    fetchImpl: options.fetchImpl ?? fetch,
  }) : null);

  const attachmentDirectory = options.attachmentDirectory ?? `${dirname(options.statePath ?? process.env.APOLLO_STATE_FILE ?? defaultStatePath())}/attachments`;
  // Set in start(): options.cloud ({ url, token } or null), else APOLLO_CLOUD_* env or the cloud file.
  let cloud = null;
  let approvalBridge = null;
  let revocationTimer = null;

  // Cloud mint and revoke for one device run one at a time, in call order.
  const deviceQueues = new Map();
  function perDevice(deviceId, task) {
    const run = (deviceQueues.get(deviceId) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    deviceQueues.set(deviceId, tail);
    tail.then(() => { if (deviceQueues.get(deviceId) === tail) deviceQueues.delete(deviceId); });
    return run;
  }

  const isPaired = async (deviceId) => (await store.read()).devices.some((device) => device.id === deviceId && !device.revoked_at);
  const queueCloudRevocation = (state, deviceId) => {
    state.cloud_revocations = [...new Set([...(state.cloud_revocations ?? []), deviceId])];
  };

  /** Deletes queued cloud device tokens. A 404 counts as done; other failures stay queued for the timer. */
  async function flushCloudRevocations() {
    if (!cloud) return;
    for (const deviceId of (await store.read()).cloud_revocations ?? []) {
      await perDevice(deviceId, async () => {
        try { await cloud.revokeDeviceToken(deviceId); }
        catch (cause) { if (cause.status !== 404) return; }
        await store.update((state) => { state.cloud_revocations = (state.cloud_revocations ?? []).filter((id) => id !== deviceId); });
      });
    }
  }

  /** Mints a cloud device token for a paired phone. Pairing never fails because of the cloud. */
  async function cloudCredentials(deviceId) {
    if (!cloud) return null;
    const credentials = await perDevice(deviceId, async () => {
      if (!await isPaired(deviceId)) return null;
      let minted;
      try { minted = await cloud.mintDeviceToken(deviceId); } catch { return null; }
      if (typeof minted?.token !== "string") return null;
      if (await isPaired(deviceId)) return { url: cloud.url, token: minted.token };
      // Revoked while minting: the new token must not outlive the device.
      await store.update((state) => queueCloudRevocation(state, deviceId));
      return null;
    });
    if (!credentials) await flushCloudRevocations().catch(() => {});
    return credentials;
  }

  async function answerApproval(runId, choice, requestId) {
    const response = await (options.fetchImpl ?? fetch)(new URL(`/v1/runs/${encodeURIComponent(runId)}/approval`, hermesUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${hermesApiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ choice, ...(requestId ? { request_id: requestId } : {}) }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    // Other 4xx: the run or approval is gone (answered in the app thread or timed out) or the request can never succeed.
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) return false;
    if (!response.ok) throw new Error(`Hermes approval failed (${response.status})`);
    return true;
  }

  async function fetchRun(runId) {
    const response = await (options.fetchImpl ?? fetch)(new URL(`/v1/runs/${encodeURIComponent(runId)}`, hermesUrl), {
      headers: { authorization: `Bearer ${hermesApiKey}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Hermes run status failed (${response.status})`);
    return response.json();
  }

  let notificationMonitor = null;

  function removeNotificationRegistration(state, device) {
    delete device.notifications;
    for (const run of Object.values(state.notification_runs ?? {})) {
      for (const event of Object.values(run.events ?? {})) {
        if (event.targets.includes(device.id) && !event.delivered.includes(device.id)) event.delivered.push(device.id);
      }
    }
  }

  async function attachmentRequest(req, res, id) {
    if (!await authenticateDevice(req)) return error(res, 401, "device authentication required", "unauthorized");
    if (req.method === "POST" && !id) {
      const attachment = await saveAttachment(attachmentDirectory, parseJson(await readBody(req, MAX_UPLOAD_BODY_BYTES)));
      return json(res, 201, { attachment });
    }
    if (req.method === "GET" && id) {
      const { attachment, bytes } = await readAttachment(attachmentDirectory, id);
      const image = /^(image\/(png|jpeg|gif|webp|heic|heif))$/.test(attachment.mimeType);
      res.writeHead(200, { "content-type": image ? attachment.mimeType : "application/octet-stream", "content-length": bytes.length, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": image ? "inline" : "attachment" });
      return res.end(bytes);
    }
    return error(res, 404, "Attachment route not found.");
  }

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
    const presented = req.headers["x-apollo-admin-secret"] ?? bearer(req.headers);
    return typeof presented === "string" && secureEqual(presented, adminSecret);
  }

  async function descriptor() {
    const state = await store.read();
    const capabilities = await discoverCapabilities(hermesUrl, hermesApiKey);
    return {
      object: "apollo.agent",
      agent_id: state.agent_id,
      label: state.label,
      hostname: hostname(),
      connector_version: VERSION,
      proxy_base_url: "/",
      capabilities,
      auth_methods: ["pairing_token"],
      pairing: { exchange_path: EXCHANGE_PATH, url_scheme: "apollo", fragment_token: true },
      notifications: { registration_path: "/v1/apollo/notifications", available: Boolean(sendPush) },
      cloud: { token_path: "/v1/apollo/cloud-token", available: Boolean(cloud) },
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
      const pairingUrl = publicBase ? `apollo://pair?host=${encodeURIComponent(publicBase)}#token=${raw}` : null;
      return json(res, 201, { agent_id: state.agent_id, pairing_token: raw, expires_at: expires, pairing_url: pairingUrl });
    }
    if (req.method === "GET" && url.pathname === "/admin/devices") {
      const state = await store.read();
      return json(res, 200, { devices: state.devices.map(({ token_hash, notifications, ...device }) => ({ ...device, notifications_registered: Boolean(notifications) })) });
    }
    const revoke = url.pathname.match(/^\/admin\/devices\/([A-Za-z0-9._~-]+)\/revoke$/u);
    if (req.method === "POST" && revoke) {
      const device = await store.update((state) => {
        const found = state.devices.find((candidate) => candidate.id === revoke[1]);
        if (found && !found.revoked_at) {
          found.revoked_at = isoNow();
          removeNotificationRegistration(state, found);
          if (cloud) queueCloudRevocation(state, found.id);
        }
        return found;
      });
      if (device) await flushCloudRevocations().catch(() => {});
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
    const credentials = await cloudCredentials(result.device.id);
    return json(res, 201, { device_id: result.device.id, device_name: result.device.name, access_token: result.accessToken, token_type: "Bearer", scopes: result.device.scopes, ...(credentials ? { cloud: credentials } : {}) });
  }

  async function cloudToken(req, res) {
    const device = await authenticateDevice(req);
    if (!device) return error(res, 401, "device authentication required", "unauthorized");
    if (!cloud) return error(res, 503, "the cloud inbox is not configured", "cloud_unavailable");
    const credentials = await cloudCredentials(device.id);
    return credentials ? json(res, 200, { cloud: credentials }) : error(res, 502, "the cloud inbox could not mint a token", "cloud_unreachable");
  }

  let titleBusy = false;
  async function threadTitle(req, res) {
    if (!await authenticateDevice(req)) return error(res, 401, "device authentication required", "unauthorized");
    const body = parseJson(await readBody(req, 32 * 1024));
    if (typeof body.input !== "string" || !body.input.trim() || body.input.length > 8000) return error(res, 400, "input must be 1 to 8000 characters");
    if (titleBusy) return json(res, 200, { title: null });
    titleBusy = true;
    try { return json(res, 200, { title: await (options.generateThreadTitle ?? generateThreadTitle)(body.input) ?? null }); }
    finally { titleBusy = false; }
  }

  async function inbox(req, res) {
    if (!await authenticateDevice(req)) return error(res, 401, "device authentication required", "unauthorized");
    if (req.method === "GET") {
      const state = await store.read();
      return json(res, 200, { settled: state.inbox_settled ?? {}, config: state.inbox_config ?? {} });
    }
    if (req.method !== "PATCH") return error(res, 405, "method not allowed");
    const body = parseJson(await readBody(req, 256 * 1024));
    const settled = body?.settled;
    if (!settled || typeof settled !== "object" || Array.isArray(settled) ||
        (body.importOnly !== undefined && typeof body.importOnly !== "boolean") ||
        Object.entries(settled).some(([id, value]) => !/^[A-Za-z0-9._~-]{1,256}$/u.test(id) ||
          ["__proto__", "constructor", "prototype"].includes(id) ||
          (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)))) {
      return error(res, 400, "settled must map session IDs to nonnegative timestamps or null");
    }
    const config = body?.config;
    if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config) ||
        Object.entries(config).some(([id, value]) => !/^[A-Za-z0-9._~-]{1,256}$/u.test(id) ||
          ["__proto__", "constructor", "prototype"].includes(id) ||
          typeof value !== "object" || value === null || Array.isArray(value) ||
          Object.keys(value).some((key) => key !== "auto_settle" || typeof value.auto_settle !== "boolean")))) {
      return error(res, 400, "config must map session IDs to { auto_settle: boolean }");
    }
    const result = await store.update((state) => {
      state.inbox_settled ??= {};
      for (const [id, timestamp] of Object.entries(settled)) {
        // Keep reopen tombstones so another device's legacy import cannot resurrect them.
        if (!body.importOnly || !Object.hasOwn(state.inbox_settled, id)) state.inbox_settled[id] = timestamp;
      }
      if (config) {
        state.inbox_config ??= {};
        for (const [id, value] of Object.entries(config)) {
          if (value.auto_settle === undefined) delete state.inbox_config[id];
          else state.inbox_config[id] = { auto_settle: value.auto_settle };
        }
      }
      return { settled: { ...state.inbox_settled }, config: { ...state.inbox_config } };
    });
    return json(res, 200, result);
  }

  async function notifications(req, res) {
    const authenticated = await authenticateDevice(req);
    if (!authenticated) return error(res, 401, "device authentication required", "unauthorized");
    if (req.method === "GET") {
      const device = (await store.read()).devices.find((candidate) => candidate.id === authenticated.id && !candidate.revoked_at);
      const registration = device?.notifications;
      return json(res, 200, registration ? {
        registered: true,
        notify_on_approval: registration.notify_on_approval,
        notify_on_completion: registration.notify_on_completion,
        notify_on_failure: registration.notify_on_failure,
      } : { registered: false });
    }
    if (req.method === "PUT") {
      if (!sendPush) return error(res, 503, "push delivery is not configured", "notifications_unavailable");
      const registration = parseNotificationRegistration(parseJson(await readBody(req, 16 * 1024)));
      const saved = await store.update((state) => {
        const device = state.devices.find((candidate) => candidate.id === authenticated.id && !candidate.revoked_at);
        if (!device) return false;
        device.notifications = { ...registration, registered_at: isoNow() };
        return true;
      });
      if (!saved) return error(res, 401, "device authentication required", "unauthorized");
      await notificationMonitor?.registrationsChanged();
      return json(res, 200, { registered: true });
    }
    if (req.method === "DELETE") {
      await store.update((state) => {
        const device = state.devices.find((candidate) => candidate.id === authenticated.id && !candidate.revoked_at);
        if (device) removeNotificationRegistration(state, device);
      });
      return json(res, 200, { registered: false });
    }
    return error(res, 405, "method not allowed");
  }

  async function proxy(req, res, url) {
    if (!validProxyRoute(req.method, url.pathname)) return error(res, 404, "route not available through Apollo", "not_found");
    const device = await authenticateDevice(req);
    if (!device) return error(res, 401, "device authentication required", "unauthorized");
    let body;
    try { body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req); }
    catch (cause) { return error(res, cause.status ?? 400, cause.message); }
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    const headers = forwardedHeaders(req);
    headers.authorization = `Bearer ${hermesApiKey}`;
    headers["x-apollo-device-id"] = device.id;
    let upstream;
    try {
      upstream = await (options.fetchImpl ?? fetch)(new URL(`${url.pathname}${url.search}`, hermesUrl), { method: req.method, headers, body, redirect: "error", signal: controller.signal });
    } catch (cause) {
      if (res.headersSent) return;
      return error(res, 502, `Hermes is unreachable: ${cause.message}`, "hermes_unreachable");
    }
    const responseHeaders = {};
    for (const name of ["content-type", "cache-control", "etag", "last-modified", "location", "retry-after"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    if (req.method === "POST" && url.pathname === "/v1/runs" && upstream.ok) {
      const responseBody = Buffer.from(await upstream.arrayBuffer());
      try {
        const run = JSON.parse(responseBody.toString("utf8"));
        const requestBody = parseJson(body ?? Buffer.alloc(0));
        await notificationMonitor?.trackRun({ ...run, session_id: requestBody.session_id });
      } catch { /* The successful Hermes response still belongs to the caller. */ }
      res.writeHead(upstream.status, responseHeaders);
      return res.end(responseBody);
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
      if (req.method === "POST" && url.pathname === "/v1/apollo/thread-title") return threadTitle(req, res);
      if (req.method === "POST" && url.pathname === "/v1/apollo/cloud-token") return await cloudToken(req, res);
      if (url.pathname === "/v1/apollo/notifications") return await notifications(req, res);
      const attachmentRoute = url.pathname.match(/^\/v1\/apollo\/attachments(?:\/([a-f0-9-]{36}))?$/);
      if (attachmentRoute) return await attachmentRequest(req, res, attachmentRoute[1]);
      if (url.pathname === "/v1/inbox") return await inbox(req, res);
      return proxy(req, res, url);
    } catch (cause) {
      if (!res.headersSent) error(res, cause.status ?? 500, cause.message ?? "internal connector error", "internal_error");
    }
  });

  return {
    server,
    store,
    async start() {
      const state = await store.load();
      const cloudConfig = options.cloud !== undefined ? options.cloud : await loadCloudConfig({ path: options.cloudConfigPath ?? defaultCloudPath(options.statePath) });
      cloud = cloudConfig ? createCloudClient({ ...cloudConfig, fetchImpl: options.fetchImpl ?? fetch }) : null;
      approvalBridge = cloud ? createApprovalBridge({ store, client: cloud, agentId: state.agent_id, answer: answerApproval, pollInterval: options.cloudPollInterval, fallbackAfter: options.cloudFallbackAfter }) : null;
      notificationMonitor = createRunNotificationMonitor({ store, agentId: state.agent_id, fetchRun, sendPush, approvals: approvalBridge, pollInterval: options.notificationPollInterval });
      await notificationMonitor.registrationsChanged();
      approvalBridge?.start();
      if (cloud) {
        flushCloudRevocations().catch(() => {});
        revocationTimer = setInterval(() => flushCloudRevocations().catch(() => {}), options.cloudRetryInterval ?? 60_000);
        revocationTimer.unref?.();
      }
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
      return server.address();
    },
    async close() {
      notificationMonitor?.close();
      approvalBridge?.close();
      clearInterval(revocationTimer);
      await new Promise((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
    },
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

export { EXCHANGE_PATH, PUBLIC_DESCRIPTOR_PATH, PROXY_ROUTES, defaultCloudPath, defaultStatePath, validProxyRoute };
