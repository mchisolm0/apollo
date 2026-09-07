import type { HermesApprovalRequest, HermesRunEvent, HermesRunStatus } from './types.ts';

export function isRunActive(status?: HermesRunStatus['status']): boolean {
  return status !== undefined && !['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
}

/** The latest decision wins over a stale approval carried by a status response. */
export function currentApproval(events: readonly HermesRunEvent[], status?: HermesRunStatus): HermesApprovalRequest | undefined {
  if (status && !isRunActive(status.status)) return undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.event === 'approval.responded' || event.event === 'run.completed' || event.event === 'run.failed' || event.event === 'run.cancelled' || event.event === 'run.interrupted') return undefined;
    if (event.event === 'approval.request') return event;
  }
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
