import type { AgentRuntimeState, HermesRunEvent, HermesRunStatus, HermesSession } from '@/lib';
import { currentApproval, sessionRun } from '../../lib/run-state.ts';

import type { RelaySession } from './types';

export type InboxStatus = 'attention' | 'active' | 'settled';

export interface InboxSession extends RelaySession {
  activityAt: number;
  status: InboxStatus;
  settled: boolean;
  attention: boolean;
  pendingApproval: boolean;
  failed: boolean;
  settledAt?: number;
  sortAt: number;
}

export type InboxSettled = Readonly<Record<string, number>>;

/** Local-only snooze ledger: session id -> until timestamp (unix seconds). Expired entries reappear. */
export type InboxSnoozed = Readonly<Record<string, number>>;

export const SNOOZE_DURATION_SECONDS = 24 * 60 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function snoozeSession(ledger: InboxSnoozed, sessionId: string, until: number): InboxSnoozed {
  return { ...ledger, [sessionId]: until };
}

export function unsnoozeSession(ledger: InboxSnoozed, sessionId: string): InboxSnoozed {
  if (!(sessionId in ledger)) return ledger;
  const next = { ...ledger };
  delete next[sessionId];
  return next;
}

export function isSessionSnoozed(ledger: InboxSnoozed, sessionId: string, atSeconds: number = nowSeconds()): boolean {
  return (ledger[sessionId] ?? 0) > atSeconds;
}

export function pruneSnoozedLedger(ledger: InboxSnoozed, atSeconds: number = nowSeconds()): InboxSnoozed {
  return Object.fromEntries(Object.entries(ledger).filter(([, until]) => until > atSeconds));
}

export function countSnoozedSessions(sessions: readonly { id: string }[], ledger: InboxSnoozed, atSeconds: number = nowSeconds()): number {
  return sessions.reduce((count, session) => count + (isSessionSnoozed(ledger, session.id, atSeconds) ? 1 : 0), 0);
}

export type SessionInboxState = Pick<AgentRuntimeState, 'sessions' | 'runs' | 'events'>;

export type InboxEvent = Pick<HermesRunEvent, 'event' | 'runId' | 'timestamp'> & {
  sessionId?: string;
  [key: string]: unknown;
};

const TERMINAL_RUNS = new Set<HermesRunStatus['status']>(['completed', 'failed', 'cancelled', 'interrupted']);

function sessionActivity(session: HermesSession): number {
  return session.lastActive ?? session.endedAt ?? session.startedAt ?? 0;
}

function terminalActivity(session: HermesSession, run: HermesRunStatus | undefined, events: readonly InboxEvent[]): number {
  const runBelongs = run?.sessionId === session.id;
  if (!runBelongs || !run || !TERMINAL_RUNS.has(run.status)) return 0;
  return events.reduce((latest, event) => Math.max(latest, event.timestamp ?? 0), run.updatedAt ?? run.createdAt ?? 0);
}

function runIsActive(run: HermesRunStatus | undefined, session: HermesSession): boolean {
  return run?.sessionId === session.id && !TERMINAL_RUNS.has(run.status);
}

function dateLabel(timestamp: number): string {
  if (!timestamp) return '';
  return new Date(timestamp * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function eventsForRun(events: readonly InboxEvent[], run?: HermesRunStatus): readonly InboxEvent[] {
  if (!run?.runId) return events;
  return events.filter((event) => !event.runId || event.runId === run.runId);
}

function statusForSession(
  session: HermesSession,
  activeRun: HermesRunStatus | undefined,
  events: readonly InboxEvent[],
  settledAt: number | undefined,
  readAt: number | undefined,
): Pick<InboxSession, 'status' | 'settled' | 'attention' | 'pendingApproval' | 'failed'> {
  const runBelongs = activeRun?.sessionId === session.id;
  const runEvents = runBelongs ? eventsForRun(events, activeRun) : [];
  const approval = runBelongs ? currentApproval(runEvents as readonly HermesRunEvent[], activeRun) : undefined;
  const latestRequest = runEvents.findLastIndex((event) => event.event === 'approval.request');
  const latestResponse = runEvents.findLastIndex((event) => event.event === 'approval.responded');
  const pendingApproval = Boolean(approval) || Boolean(runBelongs && activeRun?.status === 'waiting_for_approval' && latestResponse < latestRequest && !runEvents.some((event) => TERMINAL_RUNS.has(event.event.replace('run.', '') as HermesRunStatus['status'])));
  const failed = Boolean(session.endReason?.toLowerCase().includes('fail') || session.endReason?.toLowerCase().includes('error') || (runBelongs && (activeRun?.status === 'failed' || runEvents.some((event) => event.event === 'run.failed'))));
  const completed = session.endedAt !== undefined || (runBelongs && (activeRun?.status === 'completed' || runEvents.some((event) => event.event === 'run.completed')));
  const revived = settledAt === undefined || Math.max(sessionActivity(session), terminalActivity(session, activeRun, runEvents)) > settledAt;

  const unread = readAt === undefined || Math.max(sessionActivity(session), terminalActivity(session, activeRun, runEvents)) > readAt;
  if (pendingApproval || ((failed || completed) && revived && unread)) {
    return { status: 'attention', settled: false, attention: true, pendingApproval, failed };
  }
  if (settledAt !== undefined && !revived) {
    return { status: 'settled', settled: true, attention: false, pendingApproval: false, failed };
  }
  return { status: 'active', settled: false, attention: false, pendingApproval: false, failed };
}

/** Derive the inbox from server state. Only events from the session’s current run contribute to terminal activity. */
export function deriveSessionInbox(
  agentId: string,
  state: SessionInboxState | undefined,
  settled: InboxSettled = {},
  read: InboxSettled = {},
): InboxSession[] {
  if (!state) return [];
  return sortSessionInbox(state.sessions.map((session) => {
    const activeRun = sessionRun(state.runs, session.id);
    const events = state.events as readonly InboxEvent[];
    const runEvents = activeRun?.sessionId === session.id ? eventsForRun(events, activeRun) : [];
    const activityAt = Math.max(sessionActivity(session), terminalActivity(session, activeRun, runEvents));
    const presentation = statusForSession(session, activeRun, events, (session.settledAt === undefined ? settled[session.id] : session.settledAt ?? undefined), read[session.id]);
    const running = runIsActive(activeRun, session);
    return {
      id: session.id,
      agentId,
      title: session.title?.trim() || 'Untitled session',
      preview: session.preview,
      updatedAt: dateLabel(activityAt),
      running,
      unread: presentation.attention,
      activityAt,
      sortAt: session.startedAt ?? activityAt,
      ...presentation,
    };
  }));
}

const STATUS_ORDER: Record<InboxStatus, number> = { attention: 0, active: 1, settled: 2 };

export function sortSessionInbox(sessions: readonly InboxSession[]): InboxSession[] {
  return [...sessions].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.status === 'active' ? b.sortAt - a.sortAt : b.activityAt - a.activityAt));
}

export function canSettleSession(session: Pick<InboxSession, 'status' | 'pendingApproval' | 'running' | 'settled'>): boolean {
  return !session.settled && !session.running && !session.pendingApproval && (session.status === 'attention' || session.status === 'active');
}

export function settleSession(session: InboxSession, settledAt = Math.floor(Date.now() / 1000)): InboxSession {
  if (!canSettleSession(session)) return session;
  return { ...session, status: 'settled', settled: true, attention: false, unread: false, settledAt };
}

export function reopenSession(session: InboxSession): InboxSession {
  if (!session.settled) return session;
  return { ...session, status: 'attention', settled: false, attention: true, unread: true };
}

const presentationKeys = ['id', 'agentId', 'title', 'preview', 'updatedAt', 'running', 'unread', 'activityAt', 'sortAt', 'status', 'settled', 'attention', 'pendingApproval', 'failed'] as const satisfies readonly (keyof InboxSession)[];

/** Keep inbox rows stable while the active transcript streams unrelated text/tool events. */
export function createSessionInboxProjector() {
  let previous: InboxSession[] = [];
  return (agentId: string, state: SessionInboxState | undefined, settled: InboxSettled, read: InboxSettled = {}): InboxSession[] => {
    const byId = new Map(previous.map((session) => [session.id, session]));
    const next = deriveSessionInbox(agentId, state, settled, read).map((session) => {
      const old = byId.get(session.id);
      return old && presentationKeys.every((key) => old[key] === session[key]) ? old : session;
    });
    if (next.length === previous.length && next.every((session, index) => session === previous[index])) return previous;
    previous = next;
    return next;
  };
}
