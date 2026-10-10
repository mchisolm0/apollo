// Bridge between the connector and the Apollo cloud inbox (cloud/src/contract.ts,
// docs/cloud-inbox.md). Optional: with no URL and token the connector behaves as before.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isIP } from "node:net";

const wait = (delay) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delay);
  timer.unref?.();
});

const loopback = (host) => host === "localhost" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127."));

/** HTTPS only, except plain HTTP to loopback for local Worker dev and tests. */
export function parseCloudUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("cloud URL is invalid"); }
  if (url.username || url.password || url.search || url.hash) throw new Error("cloud URL must not include credentials, a query or a fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) throw new Error("cloud URL must use HTTPS");
  return url.origin;
}

/**
 * Environment wins per field, then the 0600 cloud file beside the connector state.
 * Returns null unless both a URL and a connector token are present.
 */
export async function loadCloudConfig({ path, env = process.env }) {
  let saved = {};
  try { saved = JSON.parse(await readFile(path, "utf8")); }
  catch (cause) { if (cause.code !== "ENOENT") throw new Error(`Invalid cloud config at ${path}: ${cause.message}`); }
  const url = env.APOLLO_CLOUD_URL || saved.url;
  const token = env.APOLLO_CLOUD_TOKEN || saved.token;
  if (!url || !token) return null;
  return { url: parseCloudUrl(url), token: String(token).trim() };
}

export async function saveCloudConfig(path, { url, token }) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ url: parseCloudUrl(url), token }, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export function createCloudClient({ url, token, fetchImpl = fetch }) {
  async function call(method, path, body) {
    const response = await fetchImpl(new URL(path, url), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(`cloud ${method} ${path.split("?")[0]} failed (${response.status}${data?.error?.code ? ` ${data.error.code}` : ""})`), { status: response.status });
    return data;
  }
  return {
    url,
    health: () => call("GET", "/v1/health"),
    /** `name` is the connector's device id. Minting again revokes that device's previous token. */
    mintDeviceToken: (name) => call("POST", "/v1/device-tokens", { name }),
    revokeDeviceToken: (name) => call("DELETE", `/v1/device-tokens/${encodeURIComponent(name)}`),
    upsertCard: (card) => call("POST", "/v1/cards", card),
    patchCard: (id, patch) => call("PATCH", `/v1/cards/${encodeURIComponent(id)}`, patch),
    events: (source, after) => call("GET", `/v1/events?source=${encodeURIComponent(source)}&after=${after}`),
  };
}

const CHOICE = { approve: "once", reject: "deny" };
// Hermes approvals time out within minutes; this only bounds cards whose resolve kept failing.
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

function approvalCard({ agentId, runId, sessionId, approval }) {
  const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
  const link = sessionId ? `apollo://session/${encodeURIComponent(sessionId)}?agentId=${encodeURIComponent(agentId)}&runId=${encodeURIComponent(runId)}` : undefined;
  return {
    source: "hermes",
    key: `${runId}:${approval.request_id}`,
    kind: "approval",
    title: `Allow ${text(approval.tool) ?? "this command"}?`,
    body: [text(approval.description), text(approval.command) ?? text(approval.preview)].filter(Boolean).join("\n\n").slice(0, 2000) || undefined,
    ...(link ? { url: link } : {}),
    actions: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "reject", label: "Reject", style: "destructive" },
    ],
    expiresAt: new Date(Date.now() + ENTRY_TTL_MS).toISOString(),
  };
}

/**
 * Turns Hermes approvals into cloud approval cards and cloud responses back into
 * Hermes approval answers. Open cards and the event cursor live in connector state
 * (`cloud_approvals`, `cloud_events_after`) so a restart picks up where it left off.
 * `answer(runId, choice, requestId)` resolves true when Hermes took the answer and
 * false when the approval is no longer pending.
 */
export function createApprovalBridge({ store, client, agentId, answer, pollInterval = 3_000, fallbackAfter = 30_000 }) {
  let closed = false;
  // Card key → when posting it first failed with a network error or 5xx. In memory only.
  const failingSince = new Map();
  let loop = null;
  let pending = false;

  async function resolveCard(key, entry) {
    try { await client.patchCard(entry.card_id, { state: "resolved" }); }
    catch (cause) { if (cause.status !== 404) throw cause; }
    await store.update((state) => { delete state.cloud_approvals?.[key]; });
  }

  async function poll() {
    const stale = (entry) => Date.now() - Date.parse(entry.created_at) > ENTRY_TTL_MS;
    let state = await store.read();
    if (Object.values(state.cloud_approvals ?? {}).some(stale)) {
      state = await store.update((current) => {
        for (const [key, entry] of Object.entries(current.cloud_approvals ?? {})) if (stale(entry)) delete current.cloud_approvals[key];
        return current;
      });
    }
    if (!Object.keys(state.cloud_approvals ?? {}).length) return false;
    const events = await client.events("hermes", state.cloud_events_after ?? 0);
    if (!Array.isArray(events)) throw new Error("cloud events response was invalid");
    for (const event of events) {
      const entry = (await store.read()).cloud_approvals?.[event.key];
      const choice = event.type === "action" ? CHOICE[event.actionId] : undefined;
      // A transient Hermes failure throws before the cursor moves, so the event is retried.
      if (entry && choice) await answer(entry.run_id, choice, entry.request_id);
      await store.update((current) => {
        if (entry && choice) delete current.cloud_approvals?.[event.key];
        current.cloud_events_after = Math.max(current.cloud_events_after ?? 0, event.seq);
      });
    }
    return true;
  }

  function ensurePolling() {
    pending = true;
    if (loop || closed) return;
    loop = (async () => {
      let delay = pollInterval;
      while (!closed && pending) {
        pending = false;
        try {
          if (await poll()) pending = true;
          delay = pollInterval;
        } catch {
          pending = true;
          delay = Math.min(delay * 2, 30_000);
        }
        if (pending) await wait(delay);
      }
    })().finally(() => {
      loop = null;
      if (pending && !closed) ensurePolling();
    });
  }

  return {
    start() {
      ensurePolling();
    },
    /**
     * Called with each polled run status. Posts a card for a new approval and resolves
     * cards whose approval was answered elsewhere. `synced` is true once nothing is left
     * to sync. `fallback` is true while the cloud has refused the current card for
     * `fallbackAfter`, so the caller should push the approval directly.
     */
    async runStatus(runId, status) {
      const approval = status.status === "waiting_for_approval" ? status.approval : null;
      const requestId = approval?.request_id ?? (approval ? status.updated_at : null);
      const currentKey = approval ? `${runId}:${requestId}` : null;
      const open = Object.entries((await store.read()).cloud_approvals ?? {});
      let synced = true;
      for (const [key, entry] of open) {
        if (entry.run_id !== runId || key === currentKey) continue;
        try { await resolveCard(key, entry); } catch { synced = false; }
      }
      if (!currentKey || open.some(([key]) => key === currentKey)) return { synced, fallback: false };
      try {
        const card = await client.upsertCard(approvalCard({ agentId, runId, sessionId: status.session_id, approval: { ...approval, request_id: String(requestId) } }));
        if (typeof card?.id !== "string") throw new Error("cloud card response was invalid");
        await store.update((state) => {
          state.cloud_approvals ??= {};
          state.cloud_approvals[currentKey] = { card_id: card.id, run_id: runId, request_id: approval.request_id ?? null, created_at: new Date().toISOString() };
        });
        failingSince.delete(currentKey);
        ensurePolling();
        return { synced, fallback: false };
      } catch (cause) {
        const outage = cause.status === undefined || cause.status >= 500;
        if (outage && !failingSince.has(currentKey)) failingSince.set(currentKey, Date.now());
        return { synced: false, fallback: outage && Date.now() - failingSince.get(currentKey) >= fallbackAfter };
      }
    },
    close() {
      closed = true;
    },
  };
}
