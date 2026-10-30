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

// `QuickActions.initial` lives as long as the JS context, which can outlast a remounted root (Android
// activity recreation), so the launch action routes once.
let launchActionRouted = false;

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
  // Only a successful load persists, so a failed one never overwrites valid history.
  const persistable = useRef(false);
  const saves = useRef(Promise.resolve());
  // The tapped action waits here until it can be routed; `taps` re-runs routing for background taps.
  const pending = useRef<QuickActions.Action | undefined>(undefined);
  const [taps, setTaps] = useState(0);
  // Bumped per routed tap so a slow refresh for an older tap never overrides a newer one.
  const routed = useRef(0);
  // A tapped thread the refresh did not find, judged on the next render, when `runtime` shows whether it connected.
  const [missing, setMissing] = useState<RecentThread>();

  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(RECENT_THREADS_STORAGE_KEY).then((stored) => {
      if (!live) return;
      persistable.current = true;
      setRecents(parseRecentThreads(stored));
    }, () => { if (live) setRecents([]); });
    if (!launchActionRouted) {
      launchActionRouted = true;
      pending.current = QuickActions.initial;
    }
    const subscription = QuickActions.addListener((action) => {
      pending.current = action;
      setTaps((count) => count + 1);
    });
    return () => { live = false; subscription.remove(); };
  }, []);

  const thread = activeThread(pathname, params);
  // Where the user is, so a slow refresh never navigates away from somewhere they went since the tap.
  const here = `${pathname}\n${thread?.agentId ?? ''}`;
  const location = useRef(here);
  useEffect(() => { location.current = here; }, [here]);

  // A string so effects re-run only when the paired agents change, not on every agents update.
  const agentKey = loading ? undefined : agents.map((agent) => agent.id).join('\n');
  useEffect(() => {
    const action = pending.current;
    if (!action || agentKey === undefined || !recents) return;
    pending.current = undefined;
    routed.current += 1;
    const destination = shortcutDestination(action, agentKey ? agentKey.split('\n') : [], recents);
    if (!destination) return;
    if (destination.pathname === '/') {
      router.dismissTo('/');
      return;
    }
    const { id: sessionId, agentId } = destination.params;
    if (sessionId === 'new') {
      router.push(destination);
      return;
    }
    const from = location.current;
    if (from === `/session/${sessionId}\n${agentId}`) return;
    const request = routed.current;
    void (async () => {
      if (!hasSession(agentId, sessionId)) await refreshAgent(agentId).catch(() => {});
      if (request !== routed.current || from !== location.current) return;
      if (hasSession(agentId, sessionId)) return router.push(destination);
      setMissing({ agentId, sessionId, title: '' });
      router.dismissTo({ pathname: '/', params: { agentId } });
    })();
  }, [taps, agentKey, recents, router, hasSession, refreshAgent]);

  // State adjusted while rendering (not in effects) so `runtime` and `recents` are current.
  if (missing) {
    setMissing(undefined);
    // Only a reachable agent proves the thread is gone (a concurrent refresh may have found it since);
    // an offline one keeps it in the launcher.
    const agent = runtime[missing.agentId];
    if (recents && agent?.status === 'connected' && !agent.sessions.some((session) => session.id === missing.sessionId)) {
      setRecents(recents.filter((recent) => recent.agentId !== missing.agentId || recent.sessionId !== missing.sessionId));
    }
  } else if (recents && thread) {
    const title = runtime[thread.agentId]?.sessions.find((session) => session.id === thread.sessionId)?.title ?? '';
    // Same array when nothing changed, so this settles after one update.
    const next = withRecentThread(recents, { ...thread, title });
    if (next !== recents) setRecents(next);
  }

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
