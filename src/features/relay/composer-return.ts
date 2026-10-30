import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ComposerEnterBehavior } from '@apollo/native-composer-editor';
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'apollo:composer-return';

let behavior: ComposerEnterBehavior = 'send';
let loaded = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  if (!loaded) {
    loaded = true;
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored === 'send' || stored === 'newline') { behavior = stored; notify(); }
    }).catch(() => {});
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** What Return does in the composer on a hardware keyboard. Command-Return always sends. */
export function useComposerEnterBehavior(): ComposerEnterBehavior {
  return useSyncExternalStore(subscribe, () => behavior);
}

export function setComposerEnterBehavior(next: ComposerEnterBehavior) {
  behavior = next;
  notify();
  void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
}
