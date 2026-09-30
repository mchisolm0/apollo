import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { notificationDestination, type NotificationDestination } from './navigation';

export type NotificationPreferences = {
  notifyOnApproval: boolean;
  notifyOnCompletion: boolean;
  notifyOnFailure: boolean;
};

export type NotificationRegistrationClient = {
  status(): Promise<{ registered: boolean; preferences?: NotificationPreferences }>;
  register(expoPushToken: string, preferences: NotificationPreferences): Promise<void>;
  unregister(): Promise<void>;
};

export type NotificationRegistrationState = 'loading' | 'disabled' | 'enabling' | 'enabled' | 'denied' | 'unsupported' | 'error';

const defaults: NotificationPreferences = { notifyOnApproval: true, notifyOnCompletion: true, notifyOnFailure: true };

export function createNotificationRegistrationClient({ endpoint, accessToken, fetchImpl = fetch }: {
  endpoint: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): NotificationRegistrationClient {
  const url = `${endpoint.replace(/\/+$/u, '')}/v1/ekho/notifications`;
  const request = async (method: 'GET' | 'PUT' | 'DELETE', body?: unknown) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
    const response = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    const result: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw Object.assign(new Error(`Notification registration failed (${response.status})`), { status: response.status });
    return result;
    } finally { clearTimeout(timer); }
  };
  return {
    async status() {
      const result = await request('GET');
      if (!result || typeof result !== 'object' || !('registered' in result) || typeof result.registered !== 'boolean') throw new Error('Invalid notification registration response');
      if (!result.registered) return { registered: false };
      const registration = result as Record<string, unknown>;
      return {
        registered: true,
        preferences: {
          notifyOnApproval: registration.notify_on_approval === true,
          notifyOnCompletion: registration.notify_on_completion === true,
          notifyOnFailure: registration.notify_on_failure === true,
        },
      };
    },
    async register(expoPushToken, preferences) {
      await request('PUT', {
        expo_push_token: expoPushToken,
        notify_on_approval: preferences.notifyOnApproval,
        notify_on_completion: preferences.notifyOnCompletion,
        notify_on_failure: preferences.notifyOnFailure,
      });
    },
    async unregister() { await request('DELETE'); },
  };
}

export function useNotificationRegistration({ client, projectId, onError }: {
  client?: NotificationRegistrationClient;
  projectId?: string;
  onError?: (error: Error) => void;
}) {
  const [state, setState] = useState<NotificationRegistrationState>('loading');
  const [preferences, setPreferences] = useState(defaults);
  const revision = useRef(0);
  const visibleState = client ? state : 'disabled';

  useEffect(() => {
    let current = true;
    if (!client) return;
    const requestRevision = ++revision.current;
    void client.status().then((result) => {
      if (!current || requestRevision !== revision.current) return;
      if (result.preferences) setPreferences(result.preferences);
      setState(result.registered ? 'enabled' : 'disabled');
    }).catch((cause: unknown) => {
      if (!current || requestRevision !== revision.current) return;
      const error = cause instanceof Error ? cause : new Error('Could not load notification settings');
      setState('error');
      onError?.(error);
    });
    return () => { current = false; };
  }, [client, onError]);

  const enable = useCallback(async (next = preferences) => {
    revision.current += 1;
    if (!client || !projectId || Platform.OS === 'web') {
      setState('unsupported');
      return false;
    }
    setState('enabling');
    try {
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('runs', { name: 'Agent runs', importance: Notifications.AndroidImportance.DEFAULT });
      }
      let permission = await Notifications.getPermissionsAsync();
      if (!allowsNotifications(permission) && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
      if (!allowsNotifications(permission)) { setState('denied'); return false; }
      const pushToken = await Notifications.getExpoPushTokenAsync({ projectId });
      await client.register(pushToken.data, next);
      setPreferences(next);
      setState('enabled');
      return true;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Could not enable notifications');
      setState('error');
      onError?.(error);
      return false;
    }
  }, [client, onError, preferences, projectId]);

  const disable = useCallback(async () => {
    revision.current += 1;
    if (!client) return;
    try {
      await client.unregister();
      setState('disabled');
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Could not disable notifications');
      setState('error');
      onError?.(error);
    }
  }, [client, onError]);

  return { state: visibleState, preferences, enable, disable };
}

export function allowsNotifications(permission: Notifications.NotificationPermissionsStatus) {
  const status = permission.ios?.status;
  return permission.granted || status === Notifications.IosAuthorizationStatus.AUTHORIZED ||
    status === Notifications.IosAuthorizationStatus.PROVISIONAL || status === Notifications.IosAuthorizationStatus.EPHEMERAL;
}

export function useNotificationResponseNavigation({ ready, isKnownAgent, isKnownSession, navigate, onError }: {
  ready: boolean;
  isKnownAgent(agentId: string): boolean;
  isKnownSession(agentId: string, sessionId: string): boolean | Promise<boolean>;
  navigate(destination: NotificationDestination): void | Promise<void>;
  onError?: (error: Error) => void;
}) {
  const handled = useRef(new Set<string>());
  const handling = useRef(new Set<string>());
  const handle = useCallback(async (response: Notifications.NotificationResponse) => {
    const identifier = response.notification.request.identifier;
    if (handled.current.has(identifier)) return 'handled' as const;
    if (handling.current.has(identifier)) return 'pending' as const;
    const destination = notificationDestination(response.notification.request.content.data);
    if (!destination || !isKnownAgent(destination.params.agentId)) return 'invalid' as const;
    handling.current.add(identifier);
    try {
      if (!await isKnownSession(destination.params.agentId, destination.params.id)) return 'invalid' as const;
      handled.current.add(identifier);
      if (handled.current.size > 50) handled.current.delete(handled.current.values().next().value!);
      await navigate(destination);
      return 'handled' as const;
    } finally {
      handling.current.delete(identifier);
    }
  }, [isKnownAgent, isKnownSession, navigate]);

  useEffect(() => {
    if (!ready) return;
    void Notifications.getLastNotificationResponseAsync()
      .then(async (response) => {
        if (!response) return;
        if (await handle(response) !== 'pending') await Notifications.clearLastNotificationResponseAsync();
      })
      .catch((cause: unknown) => onError?.(cause instanceof Error ? cause : new Error('Could not read the notification response')));
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void handle(response).then(async (result) => {
        if (result !== 'pending') await Notifications.clearLastNotificationResponseAsync();
      }).catch((cause: unknown) => onError?.(cause instanceof Error ? cause : new Error('Could not open the notification')));
    });
    return () => subscription.remove();
  }, [handle, onError, ready]);
}
