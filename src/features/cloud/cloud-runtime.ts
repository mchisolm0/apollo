import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { CATEGORY } from '../../../cloud/src/contract';
import { cloudNotificationIntent, type CloudNotificationIntent } from './cards';
import { CloudRequestError, createCloudClient } from './cloud-client';
import { loadCloudCredential } from './cloud-credentials';
import { createRespondQueue } from './respond-queue';

type OpenIntent = Extract<CloudNotificationIntent, { type: 'open' }>;

/** App-wide response queue. It lives outside React so notification actions can use it before any screen mounts. */
export const respondQueue = createRespondQueue({
  storage: AsyncStorage,
  send: async (item) => {
    const credential = await loadCloudCredential();
    if (!credential) throw new CloudRequestError('Set up the cloud inbox to send this response.');
    return createCloudClient(credential).respond(item.cardId, item.response, item.key);
  },
});

let pendingOpen: OpenIntent | undefined;
let openRevision = 0;
const openListeners = new Set<() => void>();
const handled = new Set<string>();

/** Taps that should open a card, waiting for the router to be ready. */
export const cloudOpenRequests = {
  subscribe(listener: () => void) {
    openListeners.add(listener);
    return () => { openListeners.delete(listener); };
  },
  revision: () => openRevision,
  take(): OpenIntent | undefined {
    const intent = pendingOpen;
    pendingOpen = undefined;
    return intent;
  },
};

/**
 * Handles a cloud card notification response. Approve and Reject open the app and go
 * through the durable queue. Returns false for notifications that are not cloud cards.
 */
export async function handleCloudNotificationResponse(response: Notifications.NotificationResponse): Promise<boolean> {
  const intent = cloudNotificationIntent(response);
  if (!intent) return false;
  const id = `${response.notification.request.identifier}:${response.actionIdentifier}`;
  if (handled.has(id)) return true;
  handled.add(id);
  if (intent.type === 'respond') {
    try {
      await respondQueue.enqueue({ key: intent.key, cardId: intent.cardId, response: { actionId: intent.actionId } });
    } catch (error) {
      // Not saved, so a redelivery of the same tap may try again.
      handled.delete(id);
      throw error;
    }
    await respondQueue.flush();
  } else {
    pendingOpen = intent;
    openRevision += 1;
    openListeners.forEach((listener) => listener());
  }
  return true;
}

/** Android channels named by the Worker. Created only once permission exists, since creating one can prompt. */
export async function ensureCloudChannels() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('alerts', { name: 'Approvals and morning card', importance: Notifications.AndroidImportance.HIGH });
  await Notifications.setNotificationChannelAsync('updates', { name: 'Updates', importance: Notifications.AndroidImportance.LOW, sound: null });
}

if (Platform.OS !== 'web') {
  // Approve and Reject foreground the app for now: expo-notifications completes the iOS
  // callback before JavaScript can persist the response, and a cold start keeps it only in
  // native memory. Answering fully in the background needs native work (with the Live Activity).
  void Notifications.setNotificationCategoryAsync(CATEGORY.approval, [
    { identifier: 'approve', buttonTitle: 'Approve', options: { opensAppToForeground: true } },
    { identifier: 'open', buttonTitle: 'Open', options: { opensAppToForeground: true } },
    { identifier: 'reject', buttonTitle: 'Reject', options: { opensAppToForeground: true, isDestructive: true } },
  ]).catch(() => undefined);
  void Notifications.setNotificationCategoryAsync(CATEGORY.briefing, []).catch(() => undefined);
  Notifications.addNotificationResponseReceivedListener((response) => { void handleCloudNotificationResponse(response).catch(() => undefined); });
  // A cold launch from a notification delivers its response before this listener exists.
  const last = Notifications.getLastNotificationResponse();
  if (last) void handleCloudNotificationResponse(last).catch(() => undefined);
}
