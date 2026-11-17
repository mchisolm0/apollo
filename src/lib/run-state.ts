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
 * The requests a run still waits on, oldest first. Parallel subagents can ask at once, and Hermes
 * settles an answer by its request id, or the oldest request without one. Hermes denies a request
 * `timeoutSeconds` after it asked without an event, so with `expiry` an older one is gone.
 */
export function openApprovals(events: readonly HermesRunEvent[], expiry?: { timeoutSeconds: number; now: number }): HermesRunEvent[] {
  let open: HermesRunEvent[] = [];
  for (const event of events) {
    if (event.event === 'approval.request') open.push(event);
    else if (event.event === 'approval.responded') {
      const id = requestIdOf(event);
      const at = id ? open.findIndex((ask) => requestIdOf(ask) === id) : 0;
      if (at >= 0) open = open.filter((_, index) => index !== at);
    } else if (RUN_ENDS.has(event.event)) open = [];
  }
  if (!expiry?.timeoutSeconds) return open;
  return open.filter((ask) => ask.timestamp === undefined || ask.timestamp + expiry.timeoutSeconds > expiry.now);
}

/** The request a thread shows: the oldest one still open. Events win over a stale status approval. */
export function currentApproval(events: readonly HermesRunEvent[], status?: HermesRunStatus, expiry?: { timeoutSeconds: number; now: number }): HermesApprovalRequest | undefined {
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
