import type { NotificationBehavior } from 'expo-notifications';

import { notificationDestination } from './navigation.ts';

type VisibleSession = { agentId: string; sessionId: string };

let visibleSession: VisibleSession | undefined;

/** Publishes the focused thread and returns its blur/unmount cleanup. */
export function setVisibleNotificationSession(agentId: string, sessionId: string) {
  const session = { agentId, sessionId };
  visibleSession = session;
  return () => {
    if (visibleSession === session) visibleSession = undefined;
  };
}

export function foregroundNotificationBehavior(data: unknown, session = visibleSession): NotificationBehavior {
  // Cloud updates already land in the open inbox; keep them in the list without a banner.
  if (data && typeof data === 'object' && 'cardId' in data && 'kind' in data && data.kind === 'update') {
    return { shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false };
  }
  const destination = notificationDestination(data);
  const alert = !session || !destination || destination.params.agentId !== session.agentId || destination.params.id !== session.sessionId;
  return {
    shouldShowBanner: alert,
    shouldShowList: alert,
    shouldPlaySound: alert,
    shouldSetBadge: false,
  };
}
