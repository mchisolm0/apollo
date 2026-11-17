// The approvals each watched run waits on. Hermes's run status shows only the newest request
// and goes back to running once any request is answered, so when parallel subagents ask at once
// the older requests only show in the run's event stream.
import { VALID_ID } from "./cloud.mjs";

const RUN_ENDS = new Set(["run.completed", "run.failed", "run.cancelled", "run.interrupted"]);
// Hermes denies an unanswered request when its timeout runs out, without an event. A request
// counts as gone a little after that, so it never looks gone while Hermes still waits on it.
const GRACE_SECONDS = 5;

/** When a request counts as gone: its own `timeout_s`, which Hermes captured when it asked, else the config's. */
function deadline(ask, timeoutSeconds) {
  const limit = typeof ask.timeout_s === "number" ? ask.timeout_s : timeoutSeconds;
  return limit && typeof ask.timestamp === "number" ? ask.timestamp + limit + GRACE_SECONDS : undefined;
}

const wait = (delay, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delay);
  timer.unref?.();
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * Reads one connection of a run's event stream (`GET /v1/runs/:id/events`, server-sent events),
 * calling `onOpen()` once it is an event stream and `onEvent(seq, event)` for each event after
 * `after`. Resolves when the stream closes, and resolves `false` when the response is not an
 * event stream, so there is nothing to follow.
 */
export async function readRunEvents({ url, apiKey, runId, after, onOpen = () => {}, onEvent, signal, fetchImpl = fetch }) {
  const response = await fetchImpl(new URL(`/v1/runs/${encodeURIComponent(runId)}/events`, url), {
    headers: { authorization: `Bearer ${apiKey}`, accept: "text/event-stream", ...(after >= 0 ? { "last-event-id": String(after) } : {}) },
    redirect: "error",
    signal,
  });
  if (!response.ok) throw Object.assign(new Error(`Hermes run events failed (${response.status})`), { status: response.status });
  if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) {
    await response.body?.cancel();
    return false;
  }
  onOpen();
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const frames = buffered.split(/\r?\n\r?\n/u);
    buffered = frames.pop();
    for (const frame of frames) {
      let id, data = "";
      for (const line of frame.split(/\r?\n/u)) {
        if (line.startsWith("id:")) id = Number(line.slice(3).trim());
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      const seq = Number.isSafeInteger(id) ? id : Number.isSafeInteger(event?.seq) ? event.seq : undefined;
      if (event && typeof event.event === "string") onEvent(seq, event);
    }
  }
  return true;
}

/**
 * `readEvents(runId, after, onEvent, signal, onOpen)` is readRunEvents bound to Hermes.
 * `timeoutSeconds()` resolves Hermes's approval timeout.
 */
export function createApprovalTracker({ readEvents, timeoutSeconds, retryInterval = 2_000 }) {
  // runId → { seq, open: Map<requestId, approval>, closed: Set<requestId>, ended, stream }. `closed`
  // holds requests answered, timed out or gone, since the status keeps showing a timed-out one.
  // `stream` is "unknown" until the first connection answers, then "live" or "none".
  const runs = new Map();
  const runOf = (runId) => {
    if (!runs.has(runId)) runs.set(runId, { seq: -1, open: new Map(), closed: new Set(), ended: false, stream: "unknown" });
    return runs.get(runId);
  };
  const close = (run, id) => { run.open.delete(id); run.closed.add(id); };
  // The config's timeout as last read, for requests that don't carry their own.
  let configTimeout = 0;
  const expiredBy = (ask, at) => { const end = deadline(ask, configTimeout); return end !== undefined && typeof at === "number" && end <= at; };

  function apply(run, seq, event) {
    if (seq !== undefined) run.seq = Math.max(run.seq, seq);
    const id = typeof event.request_id === "string" && VALID_ID.test(event.request_id) ? event.request_id : null;
    // A replay can arrive after Hermes said a request was gone; it stays closed.
    if (event.event === "approval.request" && id) { if (!run.closed.has(id)) run.open.set(id, event); }
    else if (event.event === "approval.responded") {
      // Without a request id Hermes settles the oldest request still waiting then.
      const settled = id ?? [...run.open].find(([, ask]) => !expiredBy(ask, event.timestamp))?.[0];
      if (settled !== undefined) close(run, settled);
    } else if (RUN_ENDS.has(event.event)) {
      for (const open of [...run.open.keys()]) close(run, open);
      run.ended = true;
    }
  }

  return {
    /** Follows the run's events until it ends, the stream is unavailable, or `signal` aborts. */
    async follow(runId, signal) {
      const run = runOf(runId);
      let delay = retryInterval;
      while (!signal.aborted && !run.ended) {
        try {
          const read = await readEvents(runId, run.seq, (seq, event) => apply(run, seq, event), signal, () => { run.stream = "live"; });
          if (read === false) { run.stream = "none"; return; }
          delay = retryInterval;
        } catch (cause) {
          // An unknown run has no stream to follow; the status still shows its newest request.
          if (cause.status === 404) { run.stream = "none"; return; }
          if (signal.aborted) return;
          delay = Math.min(delay * 2, 30_000);
        }
        await wait(delay, signal);
      }
    },

    /**
     * The requests the run waits on, oldest first: the open ones from its events, before their
     * deadline, plus the one on `status` unless it closed.
     */
    async open(runId, status) {
      configTimeout = await timeoutSeconds().catch(() => configTimeout);
      const now = Date.now() / 1000;
      const run = runOf(runId);
      // Hermes has dropped a timed-out request from its queue, so it leaves this one too.
      for (const [id, ask] of run.open) if (expiredBy(ask, now)) close(run, id);
      const asks = [...run.open.values()];
      const current = status.status === "waiting_for_approval" ? status.approval : null;
      if (current && !run.closed.has(current.request_id) && !asks.some((ask) => ask.request_id === current.request_id)) asks.push(current);
      return asks;
    },

    /**
     * The requests whose cards can close: a Set of those the stream showed closed, null while the
     * stream hasn't answered yet (a status read then sees only the newest request, so absence means
     * nothing), and undefined without a stream, when a request off the status is gone.
     */
    settled(runId) {
      const run = runs.get(runId);
      if (!run || run.stream === "none") return undefined;
      return run.stream === "live" ? run.closed : null;
    },

    /** Hermes said this request is gone (answered elsewhere or timed out). */
    gone(runId, requestId) {
      close(runOf(runId), requestId);
    },

    forget(runId) {
      runs.delete(runId);
    },
  };
}
