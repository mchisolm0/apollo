import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import type { DevicePushToken } from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import { useApollo } from '@/lib';

import { allowsNotifications, useNotificationResponseNavigation } from './notifications';
import type { NotificationDestination } from './navigation';

const projectId = (Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId) as string | undefined;

export function NotificationNavigation() {
  const router = useRouter();
  const { agents, loading, notificationClient, hasSession, refreshAgent } = useApollo();
  const isKnownAgent = useCallback((agentId: string) => agents.some((agent) => agent.id === agentId), [agents]);
  const navigate = useCallback((destination: NotificationDestination) => router.push(destination), [router]);
  const isKnownSession = useCallback(async (agentId: string, sessionId: string) => {
    if (hasSession(agentId, sessionId)) return true;
    await refreshAgent(agentId);
    return hasSession(agentId, sessionId);
  }, [hasSession, refreshAgent]);
  useNotificationResponseNavigation({ ready: !loading, isKnownAgent, isKnownSession, navigate });

  const refreshRegistrations = useCallback(async (devicePushToken?: DevicePushToken) => {
    if (loading || !projectId || Platform.OS === 'web') return;
    const permission = await Notifications.getPermissionsAsync();
    if (!allowsNotifications(permission)) return;
    const registrations = await Promise.all(agents.map(async (agent) => {
      try {
        const client = await notificationClient(agent.id);
        const status = await client.status();
        return status.registered && status.preferences ? { client, preferences: status.preferences } : undefined;
      } catch { return undefined; }
    }));
    if (!registrations.some(Boolean)) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId, devicePushToken })).data;
    await Promise.allSettled(registrations.map((registration) => registration?.client.register(token, registration.preferences)));

  }, [agents, loading, notificationClient]);

  useEffect(() => {
    const refresh = (token?: DevicePushToken) => { void refreshRegistrations(token).catch(() => {}); };
    refresh();
    if (loading) return;
    const subscription = Notifications.addPushTokenListener(refresh);
    const foreground = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => { subscription.remove(); foreground.remove(); };
  }, [loading, refreshRegistrations]);
  return null;
}
