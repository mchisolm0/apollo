import { File } from 'expo-file-system';
import { MAX_ATTACHMENTS } from '@/lib/attachments';
import { pickAttachments, discardAttachment } from '@/features/relay/pick-attachments';
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, AppState, Keyboard, Platform, StyleSheet } from 'react-native';
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
  const { agents, runtime, messages, createSession, sessionMessages, startRun, stopRun, approveRun, retryAgent, uploadAttachment, attachmentSource } = useEkho();
  const [resolvedId, setResolvedId] = useState(id === 'new' ? undefined : id);
  const router = useRouter();
  const openInbox = () => { Keyboard.dismiss(); router.dismissTo({ pathname: '/', params: { agentId } }); };
  const [localError, setLocalError] = useState<string>();
  const [loading, setLoading] = useState(id !== 'new');
  const [acting, setActing] = useState(false);
  const [sendingText, setSendingText] = useState<string>();
  const actionLock = useRef(false);
  const pickerLock = useRef(false);
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const pendingSend = useRef<{ text: string; key: string } | undefined>(undefined);
  const { draft, setDraft, attachments, setAttachments, move: moveDraft, error: draftError } = useSessionDraft(agentId, id);
  const fileSource = useCallback((fileId: string) => attachmentSource(agentId, fileId), [agentId, attachmentSource]);
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
  const events = project({ history, events: live, runId: run?.runId, runStartedAt: run?.createdAt, runOutput: run?.output, running });
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
    finally { actionLock.current = false; setActing(false); setSendingText(undefined); }
  };

  const addAttachments = () => {
    const pick = async (kind: 'photos' | 'files') => {
      if (pickerLock.current || actionLock.current) return;
      pickerLock.current = true;
      setPicking(true);
      setLocalError(undefined);
      try { setAttachments([...attachments, ...await pickAttachments(kind, MAX_ATTACHMENTS - attachments.length)]); }
      catch (error) { setLocalError(error instanceof Error ? error.message : 'Could not attach the file. Try again.'); }
      finally { pickerLock.current = false; setPicking(false); }
    };
    Keyboard.dismiss();
    if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ options: ['Photos', 'Files', 'Cancel'], cancelButtonIndex: 2, userInterfaceStyle: 'dark' }, (index) => { if (index < 2) void pick(index === 0 ? 'photos' : 'files'); });
    else Alert.alert('Attach', undefined, [{ text: 'Photos', onPress: () => void pick('photos') }, { text: 'Files', onPress: () => void pick('files') }, { text: 'Cancel', style: 'cancel' }]);
  };

  const send = (text: string) => void act(async () => {
    setSendingText(text || attachments.map((file) => file.name).join(', '));
    let sessionId = resolvedId;
    if (!sessionId) {
      sessionId = await createSession(agentId, (text || attachments[0]?.name || 'Attached files').slice(0, 72));
      setResolvedId(sessionId);
    }
    const sendIdentity = JSON.stringify([text, attachments.map((file) => file.id)]);
    if (pendingSend.current?.text !== sendIdentity) pendingSend.current = { text: sendIdentity, key: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
    let sent = false;
    let files = attachments;
    try {
      setUploading(files.some((file) => !file.uploaded));
      for (const file of files) {
        if (file.uploaded) continue;
        const uploaded = await uploadAttachment(agentId, { name: file.name, mimeType: file.mimeType, data: await new File(file.uri).base64() });
        files = files.map((candidate) => candidate.id === file.id ? { ...candidate, uploaded } : candidate);
        setAttachments(files);
      }
      setUploading(false);
      await startRun(agentId, text, { sessionId, idempotencyKey: pendingSend.current.key, attachments: files.flatMap((file) => file.uploaded ? [file.uploaded] : []) });
      sent = true;
      pendingSend.current = undefined;
      setDraft('');
      setAttachments([]);
      files.forEach(discardAttachment);
    } catch (error) {
      if (id === 'new') Alert.alert('Could not start the thread', error instanceof Error ? error.message : 'Try again.');
      throw error;
    } finally {
      setUploading(false);
      if (id === 'new') {
        await moveDraft(sessionId, sent ? '' : text, sent ? [] : files);
        // Promote the current route without replacing the screen or its composer.
        router.setParams({ id: sessionId });
      }
    }
  });

  if (!agent) return <Redirect href="/" />;
  const connection = state?.status === 'connected' ? 'connected' : state?.status === 'connecting' ? 'connecting' : state?.status === 'revoked' ? 'revoked' : 'offline';
  const statusLabel = uploading ? 'Uploading attachments' : approval ? 'Needs approval' : running ? 'Working' : run?.status === 'failed' ? 'Failed' : run?.status === 'completed' ? 'Complete' : undefined;
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <RunScreen
        session={{ id: resolvedId ?? 'new', agentId, title: session?.title?.trim() || 'New thread', updatedAt: '' }}
        agentName={agent.label}
        events={sendingText && !running ? [...events, { id: 'sending-message', kind: 'user', text: sendingText, status: 'running' }] : events}
        connection={connection}
        approval={approval}
        draft={draft}
        attachments={attachments}
        isPicking={picking}
        onAddAttachments={addAttachments}
        onRemoveAttachment={(fileId) => {
          const removed = attachments.find((file) => file.id === fileId);
          setAttachments(attachments.filter((file) => file.id !== fileId));
          if (removed) discardAttachment(removed);
        }}
        attachmentSource={fileSource}
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
