import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Keyboard, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RunScreen, relayColors } from '@/features/relay';
import { showSessionActions } from '@/features/relay/session-actions';
import { useSessionInbox } from '@/features/relay/use-session-inbox';
import { canSettleSession } from '@/features/relay/session-inbox';
import { createTranscriptProjector } from '@/features/relay/transcript';
import { useSessionDraft } from '@/features/relay/use-session-draft';
import { useEkho } from '@/lib';
import { currentApproval, isRunActive } from '@/lib/run-state';
import type { HermesMessage, HermesRunEvent } from '@/lib';

const noMessages: readonly HermesMessage[] = [];
const noEvents: readonly HermesRunEvent[] = [];

export default function SessionRoute() {
  const { id, agentId } = useLocalSearchParams<{ id: string; agentId: string }>();
  return <Session key={agentId} id={id} agentId={agentId} />;
}

function Session({ id, agentId }: { id: string; agentId: string }) {
  const { agents, runtime, messages, createSession, sessionMessages, startRun, stopRun, approveRun, retryAgent } = useEkho();
  const [resolvedId, setResolvedId] = useState(id === 'new' ? undefined : id);
  const router = useRouter();
  const openInbox = () => { Keyboard.dismiss(); router.dismissTo({ pathname: '/', params: { agentId } }); };
  const [localError, setLocalError] = useState<string>();
  const [loading, setLoading] = useState(id !== 'new');
  const [acting, setActing] = useState(false);
  const actionLock = useRef(false);
  const pendingSend = useRef<{ text: string; key: string } | undefined>(undefined);
  const { draft, setDraft, move: moveDraft, error: draftError } = useSessionDraft(agentId, id);
  const agent = agents.find((candidate) => candidate.id === agentId);
  const state = runtime[agentId];
  const inbox = useSessionInbox(agentId, state);
  const { markRead } = inbox;
  useFocusEffect(useCallback(() => {
    if (resolvedId && !loading && !localError && AppState.currentState === 'active') {
      void markRead(resolvedId);
    }
  }, [resolvedId, loading, localError, markRead]));
  const project = useMemo(() => createTranscriptProjector(), []);

  useEffect(() => {
    if (!resolvedId) return;
    let mounted = true;
    void sessionMessages(agentId, resolvedId).catch((error: unknown) => {
      if (mounted) setLocalError(error instanceof Error ? error.message : 'Could not load thread');
    }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [agentId, resolvedId, sessionMessages]);

  const session = state?.sessions.find((candidate) => candidate.id === resolvedId);
  const run = state?.activeRun?.sessionId === resolvedId && resolvedId ? state.activeRun : undefined;
  const running = isRunActive(run?.status);
  const live = run ? state.events : noEvents;
  const history = resolvedId ? messages[`${agentId}:${resolvedId}`] ?? noMessages : noMessages;
  const events = project({ history, events: live, runId: run?.runId, runStartedAt: run?.createdAt, running });
  const request = currentApproval(live, run);
  const command = typeof request?.command === 'string' ? request.command : typeof request?.preview === 'string' ? request.preview : undefined;
  const approval = command ? {
    id: typeof request?.request_id === 'string' ? request.request_id : request?.requestId ?? 'approval',
    title: typeof request?.tool === 'string' ? `Allow ${request.tool}?` : 'Allow this command?',
    reason: typeof request?.description === 'string' ? request.description : undefined,
    command,
  } : undefined;

  const act = async (operation: () => Promise<unknown>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setActing(true);
    setLocalError(undefined);
    try { await operation(); }
    catch (error) { setLocalError(error instanceof Error ? error.message : 'The action failed. Try again.'); }
    finally { actionLock.current = false; setActing(false); }
  };

  const send = (text: string) => void act(async () => {
    let sessionId = resolvedId;
    if (!sessionId) {
      sessionId = await createSession(agentId, text.slice(0, 72));
      setResolvedId(sessionId);
    }
    if (pendingSend.current?.text !== text) pendingSend.current = { text, key: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
    let sent = false;
    try {
      await startRun(agentId, text, { sessionId, idempotencyKey: pendingSend.current.key });
      sent = true;
      pendingSend.current = undefined;
      setDraft('');
    } catch (error) {
      if (id === 'new') Alert.alert('Could not start the thread', error instanceof Error ? error.message : 'Try again.');
      throw error;
    } finally {
      if (id === 'new') {
        await moveDraft(sessionId, sent ? '' : text);
        // Promote the current route without replacing the screen or its composer.
        router.setParams({ id: sessionId });
      }
    }
  });

  if (!agent) return <Redirect href="/" />;
  const connection = state?.status === 'connected' ? 'connected' : state?.status === 'connecting' ? 'connecting' : state?.status === 'revoked' ? 'revoked' : 'offline';
  const statusLabel = approval ? 'Needs approval' : running ? 'Working' : run?.status === 'failed' ? 'Failed' : run?.status === 'completed' ? 'Complete' : undefined;
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <RunScreen
        session={{ id: resolvedId ?? 'new', agentId, title: session?.title?.trim() || 'New thread', updatedAt: '' }}
        agentName={agent.label}
        events={events}
        connection={connection}
        approval={approval}
        draft={draft}
        isLoading={loading}
        isSending={running}
        isActing={acting}
        statusLabel={statusLabel}
        error={localError ?? draftError}
        onBack={openInbox}
        onSessionActions={() => {
          const item = inbox.sessions.find((candidate) => candidate.id === resolvedId);
          showSessionActions(session?.title ?? 'Thread', [
            ...(item?.settled ? [{ label: 'Reopen thread', onPress: () => { void inbox.reopen(item.id); } }] : item && canSettleSession(item) ? [{ label: 'Finish thread', onPress: () => { void inbox.settle(item.id); openInbox(); } }] : []),
            { label: 'Agent settings', onPress: () => router.push({ pathname: '/settings/[agentId]', params: { agentId } }) },
          ]);
        }}
        onDraftChange={setDraft}
        onSend={send}
        onStop={() => void act(() => stopRun(agentId, run?.runId))}
        onAgentDetails={() => router.push({ pathname: '/settings/[agentId]', params: { agentId } })}
        onReconnect={() => void act(() => retryAgent(agentId))}
        onApprove={(value) => run && void act(() => approveRun(agentId, run.runId, 'once', { requestId: value.id === 'approval' ? undefined : value.id }))}
        onDeny={(value) => run && void act(() => approveRun(agentId, run.runId, 'deny', { requestId: value.id === 'approval' ? undefined : value.id }))}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ safeArea: { flex: 1, backgroundColor: relayColors.background } });
