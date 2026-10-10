import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { normalizeCloudUrl, type CloudCredential } from './cloud-client';

const KEY = 'apollo.cloud-credential.v1';
/** The provider's offline copy of cards. Cleared with the credential it belongs to. */
export const CARD_CACHE_KEY = 'apollo.cloud-cards.v1';

type CredentialState = Readonly<{ loaded: boolean; credential?: CloudCredential }>;

let state: CredentialState = { loaded: false };
let loading: Promise<CloudCredential | undefined> | undefined;
const listeners = new Set<() => void>();

function publish(credential?: CloudCredential) {
  state = { loaded: true, ...(credential ? { credential } : {}) };
  listeners.forEach((listener) => listener());
}

function parse(saved: string | null): CloudCredential | undefined {
  if (!saved) return undefined;
  try {
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== 'object' || !('url' in value) || !('token' in value) || !('agentId' in value)) return undefined;
    const url = typeof value.url === 'string' ? normalizeCloudUrl(value.url) : undefined;
    return url && typeof value.token === 'string' && typeof value.agentId === 'string' ? { url, token: value.token, agentId: value.agentId } : undefined;
  } catch {
    return undefined;
  }
}

/** The one cloud inbox this phone uses, kept in SecureStore. Readable outside React for notification actions. */
export function loadCloudCredential(): Promise<CloudCredential | undefined> {
  if (state.loaded) return Promise.resolve(state.credential);
  return loading ??= SecureStore.getItemAsync(KEY).then(parse, () => undefined).then((credential) => {
    if (!state.loaded) publish(credential);
    return state.credential;
  });
}

export async function saveCloudCredential(credential: CloudCredential): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(credential));
  publish(credential);
}

export async function clearCloudCredential(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
  await AsyncStorage.removeItem(CARD_CACHE_KEY).catch(() => undefined);
  publish(undefined);
}

export const cloudCredentialStore = {
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
