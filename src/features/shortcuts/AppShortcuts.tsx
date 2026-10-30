import AsyncStorage from '@react-native-async-storage/async-storage';
import * as QuickActions from 'expo-quick-actions';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { useApollo } from '@/lib';

import {
  activeThread,
  buildShortcutActions,
  parseRecentThreads,
  RECENT_THREADS_STORAGE_KEY,
  shortcutDestination,
  withRecentThread,
  type RecentThread,
} from './app-shortcuts';

// Android resolves `shortcut_icon` to the adaptive icon the expo-quick-actions plugin generates (app.config.ts).
const icon = (kind: 'new' | 'thread') =>
  Platform.OS === 'ios' ? (kind === 'new' ? 'symbol:square.and.pencil' : 'symbol:bubble.left') : 'shortcut_icon';

/**
 * Owns the home-screen quick actions (long-press the app icon): keeps "New thread" plus the recently
 * opened threads in sync and routes taps, cold launch included, once agents and recents load.
 */
export function AppShortcuts() {
  const router = useRouter();
  const { agents, runtime, loading, hasSession, refreshAgent } = useApollo();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ id?: string; agentId?: string }>();
  // null until the stored list loads, so the first thread opened after launch cannot clobber it.
  const [recents, setRecents] = useState<readonly RecentThread[] | null>(null);
  // A failed load falls back to an empty list without persisting it over valid history.
  const persistable = useRef(false);
  const saves = useRef(Promise.resolve());
  // The tapped action waits here until it can be routed; `taps` re-runs routing for background taps.
  const pending = useRef<QuickActions.Action | undefined>(QuickActions.initial);
  const [taps, setTaps] = useState(0);
  // Bumped per routed tap so a slow refresh for an older tap never overrides a newer one.
  const routed = useRef(0);

  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(RECENT_THREADS_STORAGE_KEY).then((stored) => {
      if (!live) return;
      persistable.current = true;
      setRecents(parseRecentThreads(stored));
    }, () => { if (live) setRecents([]); });
    const subscription = QuickActions.addListener((action) => {
      pending.current = action;
      setTaps((count) => count + 1);
    });
    return () => { live = false; subscription.remove(); };
  }, []);

  // A string so effects re-run only when the paired agents change, not on every agents update.
  const agentKey = loading ? undefined : agents.map((agent) => agent.id).join('\n');
  useEffect(() => {
    const action = pending.current;
    if (!action || agentKey === undefined || !recents) return;
    pending.current = undefined;
    routed.current += 1;
    const destination = shortcutDestination(action, agentKey ? agentKey.split('\n') : [], recents);
    if (destination?.pathname !== '/session/[id]' || destination.params.id === 'new') {
      if (destination) router.push(destination);
      return;
    }
    const { id: sessionId, agentId } = destination.params;
    const request = routed.current;
    void (async () => {
      if (!hasSession(agentId, sessionId)) await refreshAgent(agentId).catch(() => {});
      if (request !== routed.current) return;
      if (hasSession(agentId, sessionId)) return router.push(destination);
      // A deleted (or unreachable) thread leaves the launcher and opens its agent's inbox instead.
      persistable.current = true;
      setRecents((current) => current && current.filter((thread) => thread.agentId !== agentId || thread.sessionId !== sessionId));
      router.dismissTo({ pathname: '/', params: { agentId } });
    })();
  }, [taps, agentKey, recents, router, hasSession, refreshAgent]);

  const thread = activeThread(pathname, params);
  const agentId = thread?.agentId;
  const sessionId = thread?.sessionId;
  const title = (agentId && runtime[agentId]?.sessions.find((session) => session.id === sessionId)?.title) || '';
  const loaded = recents !== null;
  useEffect(() => {
    if (!loaded || !agentId || !sessionId) return;
    setRecents((current) => {
      if (!current) return current;
      const next = withRecentThread(current, { agentId, sessionId, title });
      if (next !== current) persistable.current = true;
      return next;
    });
  }, [loaded, agentId, sessionId, title]);

  useEffect(() => {
    if (!recents || !persistable.current) return;
    const value = JSON.stringify(recents);
    // Chained so an older list never finishes after a newer one.
    saves.current = saves.current.then(() => AsyncStorage.setItem(RECENT_THREADS_STORAGE_KEY, value)).catch(() => {});
  }, [recents]);

  useEffect(() => {
    if (!recents || agentKey === undefined) return;
    const paired = new Set(agentKey ? agentKey.split('\n') : []);
    // Threads of unpaired agents stay stored but leave the launcher.
    void QuickActions.setItems(buildShortcutActions(recents.filter((thread) => paired.has(thread.agentId)), icon)).catch(() => {});
  }, [recents, agentKey]);

  return null;
}
