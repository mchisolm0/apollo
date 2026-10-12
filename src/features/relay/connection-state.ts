import type { AgentRuntimeState } from '../../lib/types.ts';
import type { ConnectionState } from './types.ts';

/**
 * What the UI shows for an agent's runtime status. Before the first connect finishes the
 * status is missing or `idle`; during the launch grace that reads as connecting, and after it
 * as offline, so a refresh that failed before setting any state still offers Retry.
 */
export function displayConnection(status: AgentRuntimeState['status'] | undefined, graceOver: boolean): ConnectionState {
  if (status === 'connected' || status === 'revoked' || status === 'connecting' || status === 'offline') return status;
  return graceOver ? 'offline' : 'connecting';
}

/**
 * Whether inbox section counts may show. They wait for live sessions and cards so a cached
 * number never jumps, but after the launch grace they show whatever is loaded, so a failed or
 * slow load can't hide them indefinitely.
 */
export function countsReady({ sessionsLoaded, cardsLoaded, cloudOff, graceOver }: { sessionsLoaded: boolean; cardsLoaded: boolean; cloudOff: boolean; graceOver: boolean }): boolean {
  return graceOver || (sessionsLoaded && (cloudOff || cardsLoaded));
}
