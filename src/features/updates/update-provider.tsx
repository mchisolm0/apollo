import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type PropsWithChildren } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useOutbox } from '@/lib/outbox-context';
import { flushSessionDrafts } from '@/lib/session-draft';
import { createUpdateController, shouldNoticeUpdate, updateState, type UpdateState } from './update-state';

const NOTICED_KEY = 'ekho.update-noticed.v1';
const enabled = !__DEV__ && Updates.isEnabled;
type UpdateContextValue = {
  state: UpdateState;
  running: Updates.UseUpdatesReturnType['currentlyRunning'];
  noticeVisible: boolean;
  dismissNotice(): void;
  restart(): Promise<void>;
  restarting: boolean;
  error?: string;
};
const UpdateContext = createContext<UpdateContextValue | null>(null);

export function AppUpdateProvider({ children }: PropsWithChildren) {
  const snapshot = Updates.useUpdates();
  const state = updateState(enabled, snapshot);
  const outbox = useOutbox();
  const latest = useRef({ state, outbox });
  useLayoutEffect(() => { latest.current = { state, outbox }; }, [state, outbox]);
  const controller = useRef<ReturnType<typeof createUpdateController>>(undefined);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [noticedId, setNoticedId] = useState<string | null>();
  const [noticeVisible, setNoticeVisible] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled) return;
    const flow = createUpdateController({
      enabled,
      now: Date.now,
      appState: () => AppState.currentState,
      state: () => latest.current.state,
      check: Updates.checkForUpdateAsync,
      fetch: Updates.fetchUpdateAsync,
      flushDrafts: flushSessionDrafts,
      withReloadSafety: (apply) => latest.current.outbox.withReloadSafety(apply),
      reload: () => Updates.reloadAsync(),
    });
    controller.current = flow;
    let live = true;
    void AsyncStorage.getItem(NOTICED_KEY).then((id) => {
      if (live) setNoticedId(id);
    }).catch(() => { if (live) setNoticedId(null); });
    const listener = AppState.addEventListener('change', (next) => {
      setAppState(next);
      void flow.onAppState(next);
    });
    return () => { live = false; listener.remove(); };
  }, []);

  const readyId = state.status === 'ready' ? state.update.id : undefined;
  useEffect(() => {
    if (noticedId === undefined || !readyId || !shouldNoticeUpdate(latest.current.state, noticedId, appState === 'active')) return;
    let live = true;
    void AsyncStorage.setItem(NOTICED_KEY, readyId).catch(() => undefined).then(() => {
      if (!live) return;
      setNoticedId(readyId);
      setNoticeVisible(true);
    });
    return () => { live = false; };
  }, [readyId, noticedId, appState]);

  useEffect(() => {
    if (!noticeVisible || appState !== 'active') return;
    const timer = setTimeout(() => setNoticeVisible(false), 8_000);
    return () => clearTimeout(timer);
  }, [noticeVisible, appState]);

  async function restart() {
    if (restarting) return;
    setRestarting(true);
    setError(undefined);
    if (!await controller.current?.restart()) {
      setError('Could not restart safely. Wait for sends and saved drafts, then try again.');
      setRestarting(false);
    }
  }

  return <UpdateContext.Provider value={{
    state, running: snapshot.currentlyRunning, noticeVisible: noticeVisible && appState === 'active',
    dismissNotice: () => setNoticeVisible(false), restart, restarting, error,
  }}>{children}</UpdateContext.Provider>;
}

export function useAppUpdate() {
  const update = useContext(UpdateContext);
  if (!update) throw new Error('useAppUpdate must be used within AppUpdateProvider');
  return update;
}
