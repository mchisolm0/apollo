import { useThemedStyles, type RelayPalette } from '@/features/relay/relay-ui';
import { posthog } from '@/config/posthog';
import { useOutbox } from '@/lib/outbox-context';
import { useIncomingShares } from '@/features/sharing';
import { MAX_ATTACHMENTS } from '@/lib/attachments';
import { pickAttachments, persistPastedImages, copySharedAttachments, discardAttachment } from '@/features/relay/pick-attachments';
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, AppState, Keyboard, Platform, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RunScreen } from '@/features/relay';
import { showSessionActions } from '@/features/relay/session-actions';
import { useSessionInbox } from '@/features/relay/use-session-inbox';
import { canSettleSession } from '@/features/relay/session-inbox';
import { createTranscriptProjector } from '@/features/relay/transcript';
import { selectedSkillNames } from '@/features/relay/composer-skills';
import { useSessionDraft } from '@/features/relay/use-session-draft';
import { setVisibleNotificationSession } from '@/features/notifications/foreground';
import { useEkho } from '@/lib';
import { currentApproval, isRunActive, sessionRun } from '@/lib/run-state';
import { sessionModelChoice } from '@/lib/hermes-client';
import type { HermesMessage, HermesModel, HermesRunEvent, HermesSkill } from '@/lib';

const noMessages: readonly HermesMessage[] = [];
const noEvents: readonly HermesRunEvent[] = [];

export default function SessionRoute() {
  const { id, agentId, draft, shareId } = useLocalSearchParams<{ id: string; agentId: string; draft?: string; shareId?: string }>();
  // A new thread keeps its screen and composer when its first send assigns a session id.
  const isDraft = id === 'new' || draft === '1';
  return <Session key={`${agentId}:${isDraft ? 'draft' : id}`} id={id} agentId={agentId} shareId={shareId} />;
}

function Session({ id, agentId, shareId }: { id: string; agentId: string; shareId?: string }) {
  const styles = useThemedStyles(createStyles);
  const { agents, runtime, messages, sessionMessages, skills: loadSkills, models: loadModels, stopRun, approveRun, retryAgent, attachmentSource, deleteSession, regenerateTitle, sessionDetail, setSessionModel } = useEkho();
  const outbox = useOutbox();
  const { getShare, acknowledgeShare } = useIncomingShares();
  const [retryRevision, setRetryRevision] = useState(0);
  const [resolvedId, setResolvedId] = useState(id === 'new' ? undefined : id);
  useFocusEffect(useCallback(() => {
    if (resolvedId) return setVisibleNotificationSession(agentId, resolvedId);
  }, [agentId, resolvedId]));
  const router = useRouter();
  const openInbox = () => { Keyboard.dismiss(); router.dismissTo({ pathname: '/', params: { agentId } }); };
  const [localError, setLocalError] = useState<string>();
  const [loading, setLoading] = useState(id !== 'new');
  const [acting, setActing] = useState(false);
  const actionLock = useRef(false);
  const pickerLock = useRef(false);
  const [picking, setPicking] = useState(false);
  const { draft, setDraft, attachments, setAttachments, move: moveDraft, error: draftError, loaded: draftLoaded, appendShare, prepareSend, clear, retryLoad } = useSessionDraft(agentId, id);
  const fileSource = useCallback((fileId: string) => attachmentSource(agentId, fileId), [agentId, attachmentSource]);
  const agent = agents.find((candidate) => candidate.id === agentId);
  const state = runtime[agentId];
  const [skills, setSkills] = useState<readonly HermesSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string>();
  const [models, setModels] = useState<readonly HermesModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [model, setModel] = useState<HermesModel>();
  const skillRequest = useRef(0);
  const skillsReady = useRef(false);
  const refreshSkills = useCallback(() => {
    const request = ++skillRequest.current;
    setSkillsLoading(true);
    setSkillsError(undefined);
    void loadSkills(agentId).then((value) => {
      if (request === skillRequest.current) setSkills(value);
    }).catch((error: unknown) => {
      if (request === skillRequest.current) setSkillsError(error instanceof Error ? error.message : 'Could not load skills.');
    }).finally(() => { if (request === skillRequest.current) { setSkillsLoading(false); skillsReady.current = true; } });
  }, [agentId, loadSkills]);
  useFocusEffect(useCallback(() => {
    if (state?.status === 'connected') refreshSkills();
    return () => { skillRequest.current += 1; };
  }, [state?.status, refreshSkills]));
  useFocusEffect(useCallback(() => {
    if (state?.status !== 'connected') {
      setModels([]);
      setModelsLoading(false);
      return;
    }
    let live = true;
    setModelsLoading(true);
    void loadModels(agentId).then((value) => { if (live) setModels(value); }).catch(() => { if (live) setModels([]); }).finally(() => { if (live) setModelsLoading(false); });
    return () => { live = false; };
  }, [agentId, state?.status, loadModels]));
  const inbox = useSessionInbox(agentId, state);
  const { markRead } = inbox;
  useFocusEffect(useCallback(() => {
    if (resolvedId && !loading && !localError && AppState.currentState === 'active') {
      void markRead(resolvedId);
    }
  }, [resolvedId, loading, localError, markRead]));
  const queuedMessages = outbox.items.filter((item) => item.agentId === agentId && item.sessionId === resolvedId);
  const awaitingCreation = queuedMessages.some((item) => item.createsSession);
  const incoming = shareId ? getShare(shareId) : undefined;
  useEffect(() => {
    if (!incoming || !draftLoaded) return;
    let mounted = true;
    void copySharedAttachments(incoming.id, incoming.attachments)
      .then((files) => appendShare(incoming.id, incoming.text, files).then(() => files))
      .then(async () => {
        await acknowledgeShare(incoming.id);
        incoming.attachments.forEach(discardAttachment);
      })
      .then(() => { if (mounted) router.setParams({ shareId: undefined }); })
      .catch((error: unknown) => { if (mounted) setLocalError(error instanceof Error ? error.message : 'Could not save shared content.'); });
    return () => { mounted = false; };
  }, [incoming, draftLoaded, appendShare, acknowledgeShare, router, retryRevision]);
  const project = useMemo(() => createTranscriptProjector(), []);

  useEffect(() => {
    if (!resolvedId || awaitingCreation || !outbox.loaded) return;
    let mounted = true;
    void sessionMessages(agentId, resolvedId).catch((error: unknown) => {
      if (mounted) setLocalError(error instanceof Error ? error.message : 'Could not load thread');
    }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [agentId, resolvedId, sessionMessages, awaitingCreation, outbox.loaded]);

  useFocusEffect(useCallback(() => {
    if (!resolvedId || awaitingCreation || state?.status !== 'connected') return;
    let current = true;
    void sessionDetail(agentId, resolvedId).catch((cause: unknown) => {
      if (current) setLocalError(cause instanceof Error ? cause.message : 'Could not load the thread model.');
    });
    return () => { current = false; };
  }, [agentId, resolvedId, awaitingCreation, state?.status, sessionDetail]));

  const session = state?.sessions.find((candidate) => candidate.id === resolvedId);
  const selectedModel = sessionModelChoice(session?.model, session?.selectedModel ?? model);
  const run = sessionRun(state?.runs ?? {}, resolvedId);
  const running = isRunActive(run?.status);
  const runId = run?.runId;
  const allEvents = state?.events ?? noEvents;
  const live = runId ? allEvents.filter((event) => event.runId === runId) : noEvents;
  const history = resolvedId ? messages[`${agentId}:${resolvedId}`] ?? noMessages : noMessages;
  const events = project({ history, events: live, runId: run?.runId, runStartedAt: run?.createdAt, runEndedAt: run?.updatedAt, runStatus: run?.status, runOutput: run?.output, running });
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

  const pick = async (kind: 'photos' | 'files') => {
      if (pickerLock.current || actionLock.current || !draftLoaded || incoming) return;
      pickerLock.current = true;
      setPicking(true);
      setLocalError(undefined);
      try {
        const picked = await pickAttachments(kind, MAX_ATTACHMENTS - attachments.length);
        setAttachments([...attachments, ...picked]);
        if (picked.length) posthog.capture('attachment_added', { kind, count: picked.length, agent_id: agentId });
      }
      catch (error) { setLocalError(error instanceof Error ? error.message : 'Could not attach the file. Try again.'); }
      finally { pickerLock.current = false; setPicking(false); }
    };
  const addAttachments = () => {
    Keyboard.dismiss();
    if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ options: ['Photos', 'Files', 'Cancel'], cancelButtonIndex: 2, userInterfaceStyle: 'dark' }, (index) => { if (index < 2) void pick(index === 0 ? 'photos' : 'files'); });
    else Alert.alert('Attach', undefined, [{ text: 'Photos', onPress: () => void pick('photos') }, { text: 'Files', onPress: () => void pick('files') }, { text: 'Cancel', style: 'cancel' }]);
  };

  const pasteImages = async (uris: readonly string[]) => {
    if (pickerLock.current || actionLock.current || !draftLoaded) return;
    pickerLock.current = true;
    setPicking(true);
    try { setAttachments([...attachments, ...await persistPastedImages(uris, MAX_ATTACHMENTS - attachments.length)]); }
    catch (error) { setLocalError(error instanceof Error ? error.message : 'Could not paste images.'); }
    finally { pickerLock.current = false; setPicking(false); }
  };

  const send = (text: string) => void act(async () => {
    if (pickerLock.current) return;
    // Skill instructions need a live catalog lookup. Offline, send the raw text.
    // A send racing the initial catalog load refetches once so $skill refs still resolve.
    let catalog = skills;
    if (state?.status === 'connected' && (skillsLoading || !skillsReady.current)) {
      try {
        catalog = await loadSkills(agentId);
        setSkills(catalog);
        skillsReady.current = true;
      } catch {
        catalog = skills;
      }
    }
    const requestedSkills = state?.status === 'connected' ? selectedSkillNames(text, catalog) : [];
    const instructions = requestedSkills.length
      ? `The user explicitly selected these installed skills: ${JSON.stringify(requestedSkills)}. Before responding, call skill_view for each exact name and follow its instructions. The $name references in the message identify these selections. If a skill cannot be loaded, tell the user.`
      : undefined;
    const prepared = await prepareSend();
    await outbox.enqueue({ ...prepared, agentId, createsSession: !resolvedId || awaitingCreation, instructions, model: selectedModel?.id, provider: selectedModel?.provider });
    if (!resolvedId) {
      await moveDraft(prepared.sessionId, '', []);
      setResolvedId(prepared.sessionId);
      router.setParams({ id: prepared.sessionId, draft: '1' });
    } else await clear();
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
        skills={skills}
        skillsLoading={skillsLoading && state?.status === 'connected'}
        skillsError={state?.status === 'connected' ? skillsError : skills.length ? undefined : 'Reconnect to load skills.'}
        onRefreshSkills={() => {
          if (state?.status !== 'connected') void act(() => retryAgent(agentId));
          else refreshSkills();
        }}
        models={models}
        modelsLoading={modelsLoading}
        defaultModel={state?.capabilities?.model}
        selectedModel={selectedModel?.id}
        selectedProvider={selectedModel?.provider}
        onSelectModel={(choice) => {
          if (!resolvedId || awaitingCreation) setModel(choice);
          else void act(async () => {
            const lock = await setSessionModel(agentId, resolvedId, choice);
            setModel({ id: lock.model, provider: lock.provider });
          });
        }}
        attachments={attachments}
        isPicking={picking}
        onAddAttachments={addAttachments}
        onPasteImages={(uris) => void pasteImages(uris)}
        queuedMessages={queuedMessages}
        onRetryQueued={(messageId) => void act(() => outbox.retry(messageId))}
        onSteerQueued={run && running && run.status !== 'stopping' && !approval ? (messageId) => void act(() => outbox.steer(messageId, run.runId)) : undefined}
        onRemoveQueued={(messageId) => void act(() => outbox.remove(messageId))}
        sendDisabled={!draftLoaded || !outbox.loaded || Boolean(incoming)}
        onPickAttachments={(kind) => { void pick(kind); }}
        onRemoveAttachment={(fileId) => {
          const removed = attachments.find((file) => file.id === fileId);
          setAttachments(attachments.filter((file) => file.id !== fileId));
          if (removed) discardAttachment(removed);
        }}
        attachmentSource={fileSource}
        isLoading={loading && !awaitingCreation}
        isSending={running}
        isActing={acting}
        statusLabel={statusLabel}
        error={localError ?? draftError ?? outbox.error}
        onRetryError={() => void act(async () => {
          await retryLoad();
          await outbox.reload();
          setRetryRevision((value) => value + 1);
          if (!incoming) {
            await retryAgent(agentId);
            if (resolvedId && !awaitingCreation) await sessionMessages(agentId, resolvedId);
          }
        })}
        onBack={openInbox}
        onSessionActions={() => {
          const item = inbox.sessions.find((candidate) => candidate.id === resolvedId);
          const lastUserText = [...history].reverse().find((message) => message.role === 'user' && message.content?.trim())?.content?.trim();
          const titleInput = lastUserText ?? session?.title?.trim() ?? '';
          showSessionActions(session?.title ?? 'Thread', [
            ...(item?.settled ? [{ label: 'Reopen thread', onPress: () => { void inbox.reopen(item.id); } }] : item && canSettleSession(item) ? [{ label: 'Finish thread', onPress: () => { void inbox.settle(item.id); openInbox(); } }] : []),
            ...(item && !item.settled && inbox.loaded ? [{ label: `Auto-settle ${item.autoSettleDisabled ? 'On' : 'Off'}`, onPress: () => { void inbox.setAutoSettle(item.id, item.autoSettleDisabled); } }] : []),
            ...(resolvedId && titleInput ? [{ label: 'Regenerate title', onPress: () => { void act(() => regenerateTitle(agentId, resolvedId, titleInput)); } }] : []),
            ...(resolvedId ? [{ label: 'Delete thread', destructive: true, onPress: () => Alert.alert('Delete thread?', `"${session?.title ?? 'Thread'}" will be permanently removed.`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => { void act(() => deleteSession(agentId, resolvedId).then(openInbox)); } },
            ]) }] : []),
            { label: 'Agent settings', onPress: () => router.push({ pathname: '/settings/[agentId]', params: { agentId } }) },
          ]);
        }}
        onDraftChange={setDraft}
        onSend={send}
        onStop={() => run && void act(() => stopRun(agentId, run.runId))}
        onAgentDetails={() => router.push({ pathname: '/settings/[agentId]', params: { agentId } })}
        onReconnect={() => { posthog.capture('agent_reconnected', { agent_id: agentId }); void act(() => retryAgent(agentId)); }}
        onApprove={(value) => run && void act(() => approveRun(agentId, run.runId, 'once', { requestId: value.id === 'approval' ? undefined : value.id }))}
        onDeny={(value) => run && void act(() => approveRun(agentId, run.runId, 'deny', { requestId: value.id === 'approval' ? undefined : value.id }))}
      />
    </SafeAreaView>
  );
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({ safeArea: { flex: 1, backgroundColor: colors.background } });
