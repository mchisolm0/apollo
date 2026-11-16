// Away mode: while it is on, the connector denies every Hermes approval on the runs it
// watches instead of asking the phone. Turning it off posts one cloud card listing them.
import { sessionLink, VALID_ID } from "./cloud.mjs";

// An update card holds at most 200 picks.
const MAX_PICKS = 200;
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const clip = (value, max) => value.length <= max ? value : `${value.slice(0, max - 1)}…`;

function summaryCard(agentId, since, denied) {
  const shown = denied.slice(0, MAX_PICKS);
  return {
    source: "hermes",
    // No colon, so the approval bridge never reads its events as an approval answer.
    key: `away-${Date.parse(since) || 0}`,
    kind: "update",
    title: `Denied ${denied.length} ${denied.length === 1 ? "approval" : "approvals"} while away`,
    ...(denied.length > shown.length ? { body: `${denied.length - shown.length} more not listed.` } : {}),
    picks: shown.map((entry, n) => ({
      n,
      text: clip(entry.command ?? entry.description ?? entry.tool ?? "Approval", 200),
      ...(entry.tool ? { sub: clip(entry.tool, 200) } : {}),
      ...(entry.session_id ? { url: sessionLink(agentId, entry.session_id, entry.run_id) } : {}),
      done: false,
    })),
  };
}

/**
 * State lives in `state.away = { on, since, denied: [{ key, run_id, session_id, tool, command, description, at }] }`.
 * `answer(runId, choice, requestId)` is the bridge's Hermes answer: true when taken, false when the
 * approval is gone, throws on a transient failure. `cloud()` returns the cloud client or null.
 */
export function createAwayMode({ store, agentId, answer, cloud }) {
  const enabled = () => store.current().away?.on === true;
  const view = (away = {}) => ({ on: away.on === true, ...(away.since ? { since: away.since } : {}), denied: away.denied?.length ?? 0 });

  /**
   * Posts the summary of a finished away period, then clears it. Kept for the next try if the cloud
   * fails. Without a cloud inbox there is nowhere to list them, so they are cleared unposted; each
   * denial still shows in its thread.
   */
  async function report() {
    const away = (await store.read()).away;
    if (away?.on || !away?.denied?.length) return false;
    const client = cloud();
    if (client) {
      try { await client.upsertCard(summaryCard(agentId, away.since, away.denied)); }
      catch { return false; }
    }
    await store.update((state) => {
      if (!state.away || state.away.on) return;
      const reported = new Set(away.denied.map((entry) => entry.key));
      state.away.denied = state.away.denied.filter((entry) => !reported.has(entry.key));
    });
    return Boolean(client);
  }

  return {
    /** Sync so the run monitor can ask on every poll without waiting on a state write. */
    enabled,

    async read() {
      return view((await store.read()).away);
    },

    /** Turning off reports what was denied. Off again retries a failed report; on keeps unreported entries. */
    async set(on) {
      await store.update((state) => {
        if (on && !state.away?.on) state.away = { on: true, since: new Date().toISOString(), denied: state.away?.denied ?? [] };
        else if (!on && state.away) state.away.on = false;
      });
      const reported = on ? false : await report();
      return { ...view((await store.read()).away), reported };
    },

    /**
     * Denies a waiting approval while away. Resolves true when Hermes took the denial, false
     * when away is off, the approval has no usable id, or it is already gone.
     */
    async deny(runId, status) {
      const approval = status.status === "waiting_for_approval" ? status.approval : null;
      if (!enabled() || !approval || !(typeof approval.request_id === "string" && VALID_ID.test(approval.request_id))) return false;
      if (!await answer(runId, "deny", approval.request_id)) return false;
      const key = `${runId}:${approval.request_id}`;
      await store.update((state) => {
        state.away ??= { on: false, denied: [] };
        state.away.denied ??= [];
        if (state.away.denied.some((entry) => entry.key === key)) return;
        state.away.denied.push({
          key,
          run_id: runId,
          session_id: text(status.session_id),
          tool: text(approval.tool),
          command: text(approval.command) ?? text(approval.preview),
          description: text(approval.description),
          at: new Date().toISOString(),
        });
      });
      return true;
    },
  };
}
