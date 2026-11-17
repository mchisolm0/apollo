import type { HermesApprovalRequest, HermesRunEvent, HermesRunStatus } from './types.ts';

export function isRunActive(status?: HermesRunStatus['status']): boolean {
  return status !== undefined && ['queued', 'started', 'running', 'waiting_for_approval', 'stopping'].includes(status);
}

const RUN_ENDS = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);
const requestIdOf = (event: Readonly<Record<string, unknown>>): string | undefined => {
  const id = event.request_id ?? event.requestId;
  return typeof id === 'string' && id ? id : undefined;
};

/**
 * When Hermes denies a request nobody answered: its own `timeout_s`, which Hermes captured when it
 * asked, else `timeoutSeconds` from the config. Hermes denies it then without an event.
 */
export function approvalDeadline(ask: Readonly<Record<string, unknown>>, timeoutSeconds?: number): number | undefined {
  const limit = typeof ask.timeout_s === 'number' ? ask.timeout_s : timeoutSeconds;
  return limit && typeof ask.timestamp === 'number' ? ask.timestamp + limit : undefined;
}

type ApprovalView = { timeoutSeconds?: number; now?: number };
const expiredBy = (ask: Readonly<Record<string, unknown>>, at: number | undefined, timeoutSeconds?: number) => {
  const deadline = approvalDeadline(ask, timeoutSeconds);
  return deadline !== undefined && at !== undefined && deadline <= at;
};

/**
 * The requests a run still waits on, oldest first. Parallel subagents can ask at once, and Hermes
 * settles an answer by its request id, or else the oldest `resolved` requests still waiting. Hermes's
 * own events are replayed first; an `approval.gone` event (Apollo heard the request already closed)
 * and, with `view.now`, a deadline then only hide requests, so a late id-less answer still settles
 * the request Hermes settled.
 */
export function openApprovals(events: readonly HermesRunEvent[], view?: ApprovalView): HermesRunEvent[] {
  let open: HermesRunEvent[] = [];
  const closed = new Set<string>();
  for (const event of events) {
    const id = requestIdOf(event);
    if (event.event === 'approval.request') {
      if (!id || (!closed.has(id) && !open.some((ask) => requestIdOf(ask) === id))) open.push(event);
    } else if (event.event === 'approval.responded') {
      if (id) {
        closed.add(id);
        open = open.filter((ask) => requestIdOf(ask) !== id);
      } else {
        const count = typeof event.resolved === 'number' && event.resolved > 0 ? event.resolved : 1;
        const settled = open.filter((ask) => !expiredBy(ask, event.timestamp, view?.timeoutSeconds)).slice(0, count);
        open = open.filter((ask) => !settled.includes(ask));
      }
    } else if (RUN_ENDS.has(event.event)) open = [];
  }
  return open.filter((ask) => !hidden(events, ask, view));
}

/** Whether Apollo heard this request already closed, or its deadline passed by `view.now`. */
function hidden(events: readonly HermesRunEvent[], ask: Readonly<Record<string, unknown>>, view?: ApprovalView): boolean {
  const id = requestIdOf(ask);
  return Boolean(id && events.some((event) => event.event === 'approval.gone' && requestIdOf(event) === id)) || expiredBy(ask, view?.now, view?.timeoutSeconds);
}

/** The request a thread shows: the oldest one still open. Events win over a stale status approval. */
export function currentApproval(events: readonly HermesRunEvent[], status?: HermesRunStatus, view?: ApprovalView): HermesApprovalRequest | undefined {
  if (status && !isRunActive(status.status)) return undefined;
  const decided = events.some((event) => event.event === 'approval.request' || event.event === 'approval.responded' || RUN_ENDS.has(event.event));
  if (decided) return openApprovals(events, view)[0];
  return status?.status === 'waiting_for_approval' && status.approval && !hidden(events, status.approval, view) ? status.approval : undefined;
}

export function statusAfterEvent(run: HermesRunStatus, event: HermesRunEvent): HermesRunStatus {
  const status = event.event === 'approval.request' ? 'waiting_for_approval'
    : event.event === 'approval.responded' ? 'running'
      : event.event === 'run.completed' ? 'completed'
        : event.event === 'run.failed' ? 'failed'
          : event.event === 'run.cancelled' ? 'cancelled'
            : event.event === 'run.interrupted' ? 'interrupted'
              : event.event === 'run.started' ? 'running' : undefined;
  if (!status) return run;
  return { ...run, status, updatedAt: event.timestamp ?? run.updatedAt, approval: status === 'waiting_for_approval' ? event : undefined };
}

/** Only explicit event identities can distinguish replay from repeated text. */
export function eventTransportIdentity(event: HermesRunEvent): string | undefined {
  for (const name of ['event_id', 'eventId', 'sequence_id', 'sequenceId', 'sequence', 'seq', 'cursor']) {
    const value = event[name];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** Return the most recently started run for this thread. */
export function sessionRun(runs: Readonly<Record<string, HermesRunStatus>>, sessionId?: string): HermesRunStatus | undefined {
  if (!sessionId) return undefined;
  return Object.values(runs).findLast((run) => run.sessionId === sessionId);
}
