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
import { selectedSkillNames } from '@/features/relay/composer-skills';
import { useSessionDraft } from '@/features/relay/use-session-draft';
import { useEkho } from '@/lib';
import { currentApproval, isRunActive, sessionRun } from '@/lib/run-state';
import type { HermesMessage, HermesModel, HermesRunEvent, HermesSkill } from '@/lib';

const noMessages: readonly HermesMessage[] = [];
const noEvents: readonly HermesRunEvent[] = [];

export default function SessionRoute() {
  const { id, agentId, presentation } = useLocalSearchParams<{ id: string; agentId: string; presentation?: string }>();
  // Keep a draft's presentation stable when its first send assigns a session id.
  const isSheet = id === 'new' || presentation === 'sheet';
  return <Session key={`${agentId}:${isSheet ? 'draft' : id}`} id={id} agentId={agentId} isSheet={isSheet} />;
}

function Session({ id, agentId, isSheet }: { id: string; agentId: string; isSheet: boolean }) {
  const { agents, runtime, messages, createSession, sessionMessages, skills: loadSkills, models: loadModels, startRun, stopRun, approveRun, retryAgent, uploadAttachment, attachmentSource, deleteSession, regenerateTitle } = useEkho();
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
  const [skills, setSkills] = useState<readonly HermesSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string>();
  const [models, setModels] = useState<readonly HermesModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [model, setModel] = useState<string>();
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
  const run = sessionRun(state?.runs ?? {}, resolvedId);
  const running = isRunActive(run?.status);
  const runId = run?.runId;
  const allEvents = state?.events ?? noEvents;
  const live = runId ? allEvents.filter((event) => event.runId === runId) : noEvents;
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

  const pick = async (kind: 'photos' | 'files') => {
      if (pickerLock.current || actionLock.current) return;
      pickerLock.current = true;
      setPicking(true);
      setLocalError(undefined);
      try { setAttachments([...attachments, ...await pickAttachments(kind, MAX_ATTACHMENTS - attachments.length)]); }
      catch (error) { setLocalError(error instanceof Error ? error.message : 'Could not attach the file. Try again.'); }
      finally { pickerLock.current = false; setPicking(false); }
    };
  const addAttachments = () => {
    Keyboard.dismiss();
    if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ options: ['Photos', 'Files', 'Cancel'], cancelButtonIndex: 2, userInterfaceStyle: 'dark' }, (index) => { if (index < 2) void pick(index === 0 ? 'photos' : 'files'); });
    else Alert.alert('Attach', undefined, [{ text: 'Photos', onPress: () => void pick('photos') }, { text: 'Files', onPress: () => void pick('files') }, { text: 'Cancel', style: 'cancel' }]);
  };

  const send = (text: string) => void act(async () => {
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
      await startRun(agentId, text, { sessionId, instructions, idempotencyKey: pendingSend.current.key, attachments: files.flatMap((file) => file.uploaded ? [file.uploaded] : []), ...(model ? { model } : {}) });
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
        router.setParams({ id: sessionId, ...(isSheet ? { presentation: 'sheet' } : {}) });
      }
    }
  });

  if (!agent) return <Redirect href="/" />;
  const connection = state?.status === 'connected' ? 'connected' : state?.status === 'connecting' ? 'connecting' : state?.status === 'revoked' ? 'revoked' : 'offline';
  const statusLabel = uploading ? 'Uploading attachments' : approval ? 'Needs approval' : running ? 'Working' : run?.status === 'failed' ? 'Failed' : run?.status === 'completed' ? 'Complete' : undefined;
  return (
    <SafeAreaView style={styles.safeArea} edges={isSheet ? ['bottom'] : ['top', 'bottom']}>
      <RunScreen
        session={{ id: resolvedId ?? 'new', agentId, title: session?.title?.trim() || 'New thread', updatedAt: '' }}
        agentName={agent.label}
        events={sendingText && !running ? [...events, { id: 'sending-message', kind: 'user', text: sendingText, status: 'running' }] : events}
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
        selectedModel={model}
        onSelectModel={setModel}
        attachments={attachments}
        isPicking={picking}
        onAddAttachments={addAttachments}
        onPickAttachments={(kind) => { void pick(kind); }}
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
          const lastUserText = [...history].reverse().find((message) => message.role === 'user' && message.content?.trim())?.content?.trim();
          const titleInput = lastUserText ?? session?.title?.trim() ?? '';
          showSessionActions(session?.title ?? 'Thread', [
            ...(item?.settled ? [{ label: 'Reopen thread', onPress: () => { void inbox.reopen(item.id); } }] : item && canSettleSession(item) ? [{ label: 'Finish thread', onPress: () => { void inbox.settle(item.id); openInbox(); } }] : []),
            ...(item && !item.settled ? [{ label: `Auto-settle ${item.autoSettleDisabled ? 'On' : 'Off'}`, onPress: () => { void inbox.setAutoSettle(item.id, item.autoSettleDisabled); } }] : []),
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
        onReconnect={() => void act(() => retryAgent(agentId))}
        onApprove={(value) => run && void act(() => approveRun(agentId, run.runId, 'once', { requestId: value.id === 'approval' ? undefined : value.id }))}
        onDeny={(value) => run && void act(() => approveRun(agentId, run.runId, 'deny', { requestId: value.id === 'approval' ? undefined : value.id }))}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ safeArea: { flex: 1, backgroundColor: relayColors.background } });
