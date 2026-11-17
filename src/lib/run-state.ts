import type { HermesApprovalRequest, HermesRunEvent, HermesRunStatus } from './types.ts';

export function isRunActive(status?: HermesRunStatus['status']): boolean {
  return status !== undefined && ['queued', 'started', 'running', 'waiting_for_approval', 'stopping'].includes(status);
}

const RUN_ENDS = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);
const requestIdOf = (event: HermesRunEvent): string | undefined => {
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

/**
 * The requests a run still waits on, oldest first. Parallel subagents can ask at once, and Hermes
 * settles an answer by its request id, or the oldest request still waiting without one. With
 * `expiry.now`, a request past its deadline is gone.
 */
export function openApprovals(events: readonly HermesRunEvent[], expiry?: { timeoutSeconds?: number; now?: number }): HermesRunEvent[] {
  const expiredBy = (ask: HermesRunEvent, at: number | undefined) => {
    const deadline = approvalDeadline(ask, expiry?.timeoutSeconds);
    return deadline !== undefined && at !== undefined && deadline <= at;
  };
  let open: HermesRunEvent[] = [];
  const closed = new Set<string>();
  for (const event of events) {
    const id = requestIdOf(event);
    if (event.event === 'approval.request') {
      if (!id || (!closed.has(id) && !open.some((ask) => requestIdOf(ask) === id))) open.push(event);
    } else if (event.event === 'approval.responded') {
      const at = id ? open.findIndex((ask) => requestIdOf(ask) === id) : open.findIndex((ask) => !expiredBy(ask, event.timestamp));
      if (id) closed.add(id);
      if (at >= 0) open = open.filter((_, index) => index !== at);
    } else if (RUN_ENDS.has(event.event)) open = [];
  }
  return expiry?.now === undefined ? open : open.filter((ask) => !expiredBy(ask, expiry.now));
}

/** The request a thread shows: the oldest one still open. Events win over a stale status approval. */
export function currentApproval(events: readonly HermesRunEvent[], status?: HermesRunStatus, expiry?: { timeoutSeconds?: number; now?: number }): HermesApprovalRequest | undefined {
  if (status && !isRunActive(status.status)) return undefined;
  const decided = events.some((event) => event.event === 'approval.request' || event.event === 'approval.responded' || RUN_ENDS.has(event.event));
  if (decided) return openApprovals(events, expiry)[0];
  return status?.status === 'waiting_for_approval' ? status.approval : undefined;
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
