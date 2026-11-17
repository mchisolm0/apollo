// The approvals each watched run waits on. Hermes's run status shows only the newest request
// and goes back to running once any request is answered, so when parallel subagents ask at once
// the older requests only show in the run's event stream.
import { VALID_ID } from "./cloud.mjs";

const RUN_ENDS = new Set(["run.completed", "run.failed", "run.cancelled", "run.interrupted"]);
// Hermes denies an unanswered request when its timeout runs out, without an event. Its clock starts
// after the request's timestamp, and an answer's timestamp comes after Hermes settled it, so a
// deadline is fuzzy by about this much. A card closes this long after its deadline, and an id-less
// answer this close to a deadline settles that request, never a newer one Hermes may still wait on.
const GRACE_SECONDS = 5;

/** When Hermes denies a request: its own `timeout_s`, which Hermes captured when it asked, else the config's. */
function deadline(ask, timeoutSeconds) {
  const limit = typeof ask.timeout_s === "number" ? ask.timeout_s : timeoutSeconds;
  return limit && typeof ask.timestamp === "number" ? ask.timestamp + limit : undefined;
}
const expiredBy = (ask, at, timeoutSeconds, grace = 0) => {
  const end = deadline(ask, timeoutSeconds);
  return end !== undefined && typeof at === "number" && end + grace <= at;
};

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
  // runId → { seq, open: Map<requestId, approval>, answered: Set<requestId>, gone: Set<requestId>, ended, stream }.
  // `open` and `answered` replay Hermes's events alone. `gone` holds requests Hermes said are gone
  // when answered here; like a passed deadline it only hides a request, so a late id-less answer
  // still settles the request Hermes settled. `stream` is "unknown" until the first connection
  // answers, then "live" or "none".
  const runs = new Map();
  const runOf = (runId) => {
    if (!runs.has(runId)) runs.set(runId, { seq: -1, open: new Map(), answered: new Set(), gone: new Set(), ended: false, stream: "unknown" });
    return runs.get(runId);
  };
  const answer = (run, id) => { run.open.delete(id); run.answered.add(id); };
  // The config's timeout as last read, for requests that don't carry their own.
  let configTimeout = 0;
  // Gone here: answered, said gone, or past its deadline and grace. Hermes's status keeps showing a timed-out request.
  const closed = (run, ask, now) => run.answered.has(ask.request_id) || run.gone.has(ask.request_id) || expiredBy(ask, now, configTimeout, GRACE_SECONDS);

  function apply(run, seq, event) {
    if (seq !== undefined) run.seq = Math.max(run.seq, seq);
    const id = typeof event.request_id === "string" && VALID_ID.test(event.request_id) ? event.request_id : null;
    if (event.event === "approval.request" && id) { if (!run.answered.has(id)) run.open.set(id, event); }
    else if (event.event === "approval.responded") {
      if (id) answer(run, id);
      else {
        // Without a request id Hermes settles the oldest `resolved` requests still waiting then.
        const count = Number.isSafeInteger(event.resolved) && event.resolved > 0 ? event.resolved : 1;
        const settled = [...run.open].filter(([, ask]) => !expiredBy(ask, event.timestamp, configTimeout, GRACE_SECONDS)).slice(0, count);
        for (const [open] of settled) answer(run, open);
      }
    } else if (RUN_ENDS.has(event.event)) {
      for (const open of [...run.open.keys()]) answer(run, open);
      run.ended = true;
    }
  }

  return {
    /** Follows the run's events until it ends, the stream is unavailable, or `signal` aborts. */
    async follow(runId, signal) {
      const run = runOf(runId);
      // An id-less answer skips requests past their deadline, which can need the config's timeout.
      configTimeout = await timeoutSeconds().catch(() => configTimeout);
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
     * The requests the run waits on, oldest first: the open ones from its events, plus the one on
     * `status`, unless gone here.
     */
    async open(runId, status) {
      configTimeout = await timeoutSeconds().catch(() => configTimeout);
      const now = Date.now() / 1000;
      const run = runOf(runId);
      const asks = [...run.open.values()];
      const current = status.status === "waiting_for_approval" ? status.approval : null;
      if (current && !asks.some((ask) => ask.request_id === current.request_id)) asks.push(current);
      return asks.filter((ask) => !closed(run, ask, now));
    },

    /**
     * The requests whose cards can close: a Set of those gone here, null while the stream hasn't
     * answered yet (a status read then sees only the newest request, so absence means nothing),
     * and undefined without a stream, when a request off the status is gone.
     */
    settled(runId) {
      const run = runs.get(runId);
      if (!run || run.stream === "none") return undefined;
      if (run.stream !== "live") return null;
      const now = Date.now() / 1000;
      const expired = [...run.open.values()].filter((ask) => expiredBy(ask, now, configTimeout, GRACE_SECONDS)).map((ask) => ask.request_id);
      return new Set([...run.answered, ...run.gone, ...expired]);
    },

    /** Hermes said this request is gone (answered elsewhere or timed out). */
    gone(runId, requestId) {
      runOf(runId).gone.add(requestId);
    },

    forget(runId) {
      runs.delete(runId);
    },
  };
}
