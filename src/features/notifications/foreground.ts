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
  const destination = notificationDestination(data);
  const alert = !session || !destination || destination.params.agentId !== session.agentId || destination.params.id !== session.sessionId;
  return {
    shouldShowBanner: alert,
    shouldShowList: alert,
    shouldPlaySound: alert,
    shouldSetBadge: false,
  };
}
