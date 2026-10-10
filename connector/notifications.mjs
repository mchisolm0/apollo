const ID = /^[A-Za-z0-9._~-]{1,256}$/u;
const EXPO_PUSH_TOKEN = /^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]{1,200}\]$/u;
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

const wait = (delay) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delay);
  timer.unref?.();
});

export function parseNotificationRegistration(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("request body must be an object"), { status: 400 });
  const allowed = new Set(["expo_push_token", "notify_on_approval", "notify_on_completion", "notify_on_failure"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw Object.assign(new Error("notification registration contains unsupported fields"), { status: 400 });
  if (typeof body.expo_push_token !== "string" || !EXPO_PUSH_TOKEN.test(body.expo_push_token)) {
    throw Object.assign(new Error("expo_push_token is invalid"), { status: 400 });
  }
  for (const key of ["notify_on_approval", "notify_on_completion", "notify_on_failure"]) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") throw Object.assign(new Error(`${key} must be a boolean`), { status: 400 });
  }
  return {
    expo_push_token: body.expo_push_token,
    notify_on_approval: body.notify_on_approval ?? true,
    notify_on_completion: body.notify_on_completion ?? true,
    notify_on_failure: body.notify_on_failure ?? true,
  };
}

export function createExpoPushSender({ url = "https://exp.host/--/api/v2/push/send", accessToken, fetchImpl = fetch } = {}) {
  return async (token, notification) => {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        to: token,
        sound: "default",
        channelId: "runs",
        threadId: notification.data.session_id,
        title: notification.title,
        body: notification.body,
        data: notification.data,
      }),
    });
    if (!response.ok) throw new Error(`Expo push request failed (${response.status})`);
    const result = await response.json();
    const ticket = Array.isArray(result.data) ? result.data[0] : result.data;
    if (ticket?.status === "error") {
      if (ticket.details?.error === "DeviceNotRegistered") return { status: "unregistered" };
      throw new Error(`Expo push rejected the notification: ${ticket.details?.error ?? "unknown error"}`);
    }
    if (ticket?.status !== "ok") throw new Error("Expo push returned an invalid ticket");
    return { status: "ok" };
  };
}

function notificationFor(kind, agentId, run) {
  const copy = kind === "approval"
    ? { title: "Approval needed", body: "Open Apollo to review this request." }
    : kind === "completed"
      ? { title: "Run finished", body: "Your agent finished working." }
      : { title: "Run failed", body: "Open Apollo to review the run." };
  return {
    ...copy,
    data: { kind, agent_id: agentId, session_id: run.session_id, run_id: run.run_id },
  };
}

function eventFromStatus(status) {
  if (status.status === "waiting_for_approval") {
    const approvalId = status.approval?.request_id ?? status.updated_at;
    return { key: `approval:${String(approvalId)}`, kind: "approval" };
  }
  if (status.status === "completed") return { key: "completed", kind: "completed" };
  if (status.status === "failed") return { key: "failed", kind: "failed" };
  return null;
}

function wants(registration, kind) {
  const preference = kind === "completed" ? "notify_on_completion" : kind === "failed" ? "notify_on_failure" : "notify_on_approval";
  return registration[preference] === true;
}

/**
 * Polls runs started through the connector and pushes approval, completion and failure
 * notifications. With a cloud `approvals` bridge, approvals become cloud inbox cards
 * instead of direct pushes, and runs are watched even without a registered device.
 */
export function createRunNotificationMonitor({ store, agentId, fetchRun, sendPush, approvals = null, pollInterval = 2_000 }) {
  const active = new Map();
  let closed = false;

  async function registeredDevices() {
    const state = await store.read();
    return state.devices.filter((device) => !device.revoked_at && device.notifications);
  }

  async function deliver(runId, status, event) {
    const prepared = await store.update((state) => {
      const run = state.notification_runs?.[runId];
      if (!run) return null;
      run.session_id = typeof status.session_id === "string" && ID.test(status.session_id) ? status.session_id : run.session_id;
      run.status = status.status;
      run.updated_at = new Date().toISOString();
      run.events ??= {};
      run.events[event.key] ??= {
        kind: event.kind,
        targets: sendPush ? state.devices.filter((device) => !device.revoked_at && device.notifications && wants(device.notifications, event.kind)).map((device) => device.id) : [],
        delivered: [],
      };
      return { ...run, event: { ...run.events[event.key], key: event.key } };
    });
    if (!prepared) return true;
    if (!prepared.session_id || !ID.test(prepared.session_id)) {
      if (!TERMINAL.has(status.status)) return false;
      await store.update((current) => {
        const saved = current.notification_runs?.[runId]?.events?.[event.key];
        if (saved) saved.delivered = [...saved.targets];
      });
      return true;
    }

    for (const deviceId of prepared.event.targets) {
      if (prepared.event.delivered.includes(deviceId)) continue;
      const state = await store.read();
      const device = state.devices.find((candidate) => candidate.id === deviceId);
      if (!device || device.revoked_at || !device.notifications || !wants(device.notifications, event.kind)) {
        await markDelivered(runId, event.key, deviceId);
        continue;
      }
      try {
        const sentToken = device.notifications.expo_push_token;
        const result = await sendPush(sentToken, notificationFor(event.kind, agentId, prepared));
        await store.update((current) => {
          const currentDevice = current.devices.find((candidate) => candidate.id === deviceId);
          if (result?.status === "unregistered" && currentDevice?.notifications?.expo_push_token === sentToken) {
            delete currentDevice.notifications;
            for (const run of Object.values(current.notification_runs ?? {})) {
              for (const savedEvent of Object.values(run.events ?? {})) {
                if (savedEvent.targets.includes(deviceId) && !savedEvent.delivered.includes(deviceId)) savedEvent.delivered.push(deviceId);
              }
            }
          }
          const delivered = current.notification_runs?.[runId]?.events?.[event.key]?.delivered;
          if (delivered && !delivered.includes(deviceId)) delivered.push(deviceId);
        });
      } catch {
        // Retried by the run's bounded status loop.
      }
    }
    const state = await store.read();
    const saved = state.notification_runs?.[runId]?.events?.[event.key];
    return Boolean(saved && saved.targets.every((id) => saved.delivered.includes(id)));
  }

  async function markDelivered(runId, eventKey, deviceId) {
    await store.update((state) => {
      const delivered = state.notification_runs?.[runId]?.events?.[eventKey]?.delivered;
      if (delivered && !delivered.includes(deviceId)) delivered.push(deviceId);
    });
  }

  async function watch(runId) {
    let delay = pollInterval;
    let deliveryAttempts = 0;
    try {
      while (!closed && active.has(runId)) {
        if (!approvals && !(await registeredDevices()).length) return;
        const state = await store.read();
        const tracked = state.notification_runs?.[runId];
        if (!tracked) return;
        let status = tracked.status && TERMINAL.has(tracked.status) ? { ...tracked, run_id: runId } : null;
        if (!status) {
          try {
            status = await fetchRun(runId);
            delay = pollInterval;
          } catch {
            await wait(delay);
            delay = Math.min(delay * 2, 30_000);
            continue;
          }
        }
        let event = eventFromStatus(status);
        if (approvals) {
          // The bridge retries posting and resolving cards on its own; this only reports the run.
          const result = await approvals.runStatus(runId, { ...status, session_id: status.session_id ?? tracked.session_id });
          // The card replaces the direct approval push unless the cloud has been down too long.
          if (event?.kind === "approval" && !result.fallback) event = null;
        }
        const delivered = event ? await deliver(runId, status, event) : true;
        if (TERMINAL.has(status.status) && delivered) {
          if (!event) await store.update((current) => {
            const run = current.notification_runs?.[runId];
            if (run) { run.status = status.status; run.updated_at = new Date().toISOString(); }
          });
          return;
        }
        // Preserve failed delivery for a later registration refresh, without a permanent retry loop.
        if (TERMINAL.has(status.status) && ++deliveryAttempts >= 5) return;
        await wait(delay);
      }
    } finally {
      active.delete(runId);
    }
  }

  async function start(runId) {
    if (closed || (!sendPush && !approvals) || active.has(runId) || (!approvals && !(await registeredDevices()).length)) return;
    if (closed || active.has(runId)) return;
    active.set(runId, null);
    const operation = watch(runId).catch(() => {
      // A storage outage must not crash the connector. The next registration/run refresh retries.
    });
    active.set(runId, operation);
    await Promise.resolve();
  }

  return {
    async trackRun(run) {
      if (!run || typeof run.run_id !== "string" || !ID.test(run.run_id)) return;
      const tracked = await store.update((state) => {
        if (!approvals && !state.devices.some((device) => !device.revoked_at && device.notifications)) return false;
        state.notification_runs = Object.assign(Object.create(null), state.notification_runs ?? {});
        state.notification_runs[run.run_id] ??= {
          run_id: run.run_id,
          session_id: typeof run.session_id === "string" && ID.test(run.session_id) ? run.session_id : null,
          status: run.status,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          events: {},
        };
        const entries = Object.entries(state.notification_runs);
        // Pending delivery must survive history compaction, including failed push attempts.
        const pending = entries.filter(([, run]) => !TERMINAL.has(run.status)
          || (["completed", "failed"].includes(run.status) && !Object.keys(run.events ?? {}).length)
          || Object.values(run.events ?? {}).some((event) => event.targets.some((id) => !event.delivered.includes(id))));
        const pendingIds = new Set(pending.map(([id]) => id));
        const history = entries.filter(([id]) => !pendingIds.has(id))
          .sort(([, a], [, b]) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
        state.notification_runs = Object.fromEntries([...pending, ...history.slice(0, 256)]);
        return true;
      });
      if (tracked) await start(run.run_id);
    },
    async registrationsChanged() {
      const state = await store.read();
      await Promise.all(Object.values(state.notification_runs ?? {}).filter((run) =>
        !TERMINAL.has(run.status) || (["completed", "failed"].includes(run.status) && !Object.keys(run.events ?? {}).length) || Object.values(run.events ?? {}).some((event) => event.targets.some((id) => !event.delivered.includes(id)))
      ).map((run) => start(run.run_id)));
    },
    close() {
      closed = true;
      active.clear();
    },
  };
}

export { EXPO_PUSH_TOKEN };
