import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type PropsWithChildren } from 'react';
import { AppState, Keyboard, Platform, type AppStateStatus } from 'react-native';

import { useColors } from '@/features/relay/relay-ui';
import { useOutbox } from '@/lib/outbox-context';
import { withSessionDraftReloadSafety } from '@/lib/session-draft';
import { createUpdateController, createUpdateNoticeTimer, shouldNoticeUpdate, updateState, type UpdateState } from './update-state';

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
  const colors = useColors();
  const snapshot = Updates.useUpdates();
  const state = updateState(enabled, snapshot);
  const outbox = useOutbox();
  const latest = useRef({ state, outbox, colors });
  useLayoutEffect(() => { latest.current = { state, outbox, colors }; }, [state, outbox, colors]);
  const controller = useRef<ReturnType<typeof createUpdateController>>(undefined);
  // Set the moment a notice is shown, before the async persist lands, so a quick dismiss can't resurface it.
  const shownId = useRef<string>(undefined);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible());
  const [noticeTimer] = useState(createUpdateNoticeTimer);
  const [noticedId, setNoticedId] = useState<string | null>();
  const [noticeVisible, setNoticeVisible] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const flow = createUpdateController({
      enabled,
      now: Date.now,
      appState: () => AppState.currentState,
      state: () => latest.current.state,
      check: Updates.checkForUpdateAsync,
      fetch: Updates.fetchUpdateAsync,
      withDraftReloadSafety: withSessionDraftReloadSafety,
      withReloadSafety: (apply) => latest.current.outbox.withReloadSafety(apply),
      reload: () => Updates.reloadAsync({ reloadScreenOptions: {
        backgroundColor: latest.current.colors.background,
        spinner: { color: latest.current.colors.primary },
      } }),
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
  const noticeOnScreen = noticeVisible && !!readyId && appState === 'active' && !keyboardVisible;
  useEffect(() => {
    if (noticedId === undefined || !readyId || shownId.current === readyId || !shouldNoticeUpdate(latest.current.state, noticedId, appState === 'active', keyboardVisible)) return;
    setNoticeVisible(true);
  }, [readyId, noticedId, appState, keyboardVisible]);

  useEffect(() => {
    if (!noticeOnScreen || !readyId) return;
    shownId.current = readyId;
    void AsyncStorage.setItem(NOTICED_KEY, readyId).catch(() => undefined).then(() => setNoticedId(readyId));
  }, [noticeOnScreen, readyId]);

  useEffect(() => {
    if (!noticeOnScreen || !readyId) return;
    const timer = setTimeout(() => setNoticeVisible(false), noticeTimer.show(readyId, Date.now()));
    return () => { clearTimeout(timer); noticeTimer.hide(Date.now()); };
  }, [noticeOnScreen, readyId, noticeTimer]);

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
    state, running: snapshot.currentlyRunning, noticeVisible: noticeOnScreen,
    dismissNotice: () => setNoticeVisible(false), restart, restarting, error,
  }}>{children}</UpdateContext.Provider>;
}

export function useAppUpdate() {
  const update = useContext(UpdateContext);
  if (!update) throw new Error('useAppUpdate must be used within AppUpdateProvider');
  return update;
}
