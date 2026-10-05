import { TextInputWrapper } from 'expo-paste-input';
import * as Clipboard from 'expo-clipboard';
import { canSteerMessage, type QueuedMessage } from '../../lib/outbox';
import { followAfterScroll } from './feed-follow';
import { CopyButton } from '../content/copy-button';
import { splitAttachmentMessage, type AttachmentSource, type DraftAttachment } from '../../lib/attachments';
import { AttachmentStrip } from './attachment-strip';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { MenuView } from '@expo/ui/community/menu';
import { LegendList, useRecyclingState, type LegendListRef } from '@legendapp/list/react-native';

import { ConnectionAction, ConnectionMark, IconButton, useTextScale, useThemedStyles, useColors, type RelayPalette } from './relay-ui';
import { KeyboardFrame } from './keyboard-frame';
import { RingSpinner } from './ring-spinner';
import { insertSkill, matchingSkills, selectedSkillNames, skillTrigger, type SkillTrigger } from './composer-skills';
import { showSessionActions } from './session-actions';
import { MessageContent } from './message-content';
import { ModelPicker } from './model-picker';
import type { HermesModel, HermesSkill } from '../../lib/types';
import type { ApprovalRequest, ConnectionState, RelaySession } from './types';
import { elapsed, formatDuration, liveActivityLabel, oneLine, readableOutput, settledActivityLabel, toolVerb } from './activity';
import type { TranscriptActivityRow, TranscriptRow, TranscriptStep } from './transcript';

export type RunScreenProps = {
  session: RelaySession;
  events: readonly TranscriptRow[];
  connection: ConnectionState;
  approval?: ApprovalRequest;
  draft?: string;
  attachments?: readonly DraftAttachment[];
  isPicking?: boolean;
  onAddAttachments?: () => void;
  onPasteImages?: (uris: readonly string[]) => void;
  queuedMessages?: readonly QueuedMessage[];
  onRetryQueued?: (id: string) => void;
  onRemoveQueued?: (id: string) => void;
  onSteerQueued?: (id: string) => void;
  sendDisabled?: boolean;
  onRetryError?: () => void;
  onPickAttachments?: (kind: 'photos' | 'files') => void;
  onRemoveAttachment?: (id: string) => void;
  attachmentSource?: (id: string) => AttachmentSource | undefined;
  agentName?: string;
  isSending?: boolean;
  isLoading?: boolean;
  isActing?: boolean;
  statusLabel?: string;
  error?: string;
  skills?: readonly HermesSkill[];
  skillsLoading?: boolean;
  skillsError?: string;
  onRefreshSkills?: () => void;
  models?: readonly HermesModel[];
  modelsLoading?: boolean;
  defaultModel?: string;
  selectedModel?: string;
  selectedProvider?: string;
  onSelectModel?: (model: HermesModel) => void;
  onBack?: () => void;
  onSessionActions?: () => void;
  onDraftChange?: (value: string) => void;
  onSend: (value: string) => void;
  onStop?: () => void;
  onReconnect?: () => void;
  onAgentDetails?: () => void;
  onApprove?: (approval: ApprovalRequest) => void;
  onDeny?: (approval: ApprovalRequest) => void;
};

export function RunScreen({ session, events, connection, approval, draft = '', attachments = [], isPicking = false, onAddAttachments, onPasteImages, queuedMessages = [], onRetryQueued, onRemoveQueued, onSteerQueued, sendDisabled = false, onRetryError, onPickAttachments, onRemoveAttachment, attachmentSource, agentName, isSending = false, isLoading = false, isActing = false, statusLabel, error, skills = [], skillsLoading = false, skillsError, onRefreshSkills, models = [], modelsLoading = false, defaultModel, selectedModel, selectedProvider, onSelectModel, onBack, onSessionActions, onDraftChange, onSend, onStop, onReconnect, onAgentDetails, onApprove, onDeny }: RunScreenProps) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const { fontScale } = useWindowDimensions();
  const { factor } = useTextScale();
  const list = useRef<LegendListRef>(null);
  const input = useRef<TextInput>(null);
  const dragging = useRef(false);
  const atEnd = useRef(true);
  const dragEndTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(dragEndTimer.current), []);
  const [following, setFollowing] = useState(true);
  const [observedSelection, setObservedSelection] = useState<{ start: number; end: number; text: string }>();
  const [inputSelection, setInputSelection] = useState<{ start: number; end: number }>();
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsDismissed, setSkillsDismissed] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const activeModel = selectedModel ?? defaultModel ?? models[0]?.id;
  const selection = observedSelection?.text === draft
    ? { start: Math.min(observedSelection.start, draft.length), end: Math.min(observedSelection.end, draft.length) }
    : { start: draft.length, end: draft.length };
  const suspendFollow = useCallback(() => setFollowing(false), []);
  const renderItem = useCallback(({ item }: { item: TranscriptRow }) => item.kind === 'activity'
    ? <ActivityEntry row={item} connection={connection} onDisclosure={suspendFollow} />
    : <TranscriptEntry row={item} agentName={agentName ?? 'Hermes'} attachmentSource={attachmentSource} />, [suspendFollow, agentName, attachmentSource, connection]);
  const canSend = connection !== 'revoked' && !sendDisabled && !isActing && !isPicking && Boolean(draft.trim() || attachments.length);
  const typedSkill = selection.start === selection.end ? skillTrigger(draft, selection.end) : undefined;
  const skillMenuTrigger: SkillTrigger | undefined = !skillsDismissed ? typedSkill ?? (skillsOpen ? { query: '', start: selection.end, end: selection.end } : undefined) : undefined;
  const skillMatches = matchingSkills(skillMenuTrigger, skills);
  const selectedSkills = useMemo(() => selectedSkillNames(draft, skills), [draft, skills]);
  // Like T3: a one-line pill until the user is composing, then the full editor and toolbar.
  // Collapsed, the single line sits centered beside the action button.
  const pillHeight = Math.max(COLLAPSED_ACTION, 23 * factor + 8);
  const expanded = focused || modelOpen || attachments.length > 0 || Boolean(skillMenuTrigger);
  const action = isSending && !draft.trim() && !attachments.length
    ? <ComposerAction kind="stop" size={expanded ? EXPANDED_ACTION : COLLAPSED_ACTION} disabled={isActing || connection !== 'connected'} onPress={() => onStop?.()} />
    : <ComposerAction kind="send" size={expanded ? EXPANDED_ACTION : COLLAPSED_ACTION} label={isActing ? 'Saving message' : connection !== 'connected' || isSending || queuedMessages.length ? 'Queue message' : 'Send message'} disabled={!canSend} onPress={() => onSend(draft.trim())} />;
  const chooseSkill = (skill: HermesSkill) => {
    if (!skillMenuTrigger) return;
    const result = insertSkill(draft, skillMenuTrigger, skill.name);
    onDraftChange?.(result.text);
    setObservedSelection({ start: result.cursor, end: result.cursor, text: result.text });
    setInputSelection({ start: result.cursor, end: result.cursor });
    setSkillsOpen(false);
    setSkillsDismissed(false);
    requestAnimationFrame(() => input.current?.focus());
  };
  const endScroll = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setFollowing((current) => followAfterScroll(current, 'end', atEnd.current));
  };
  return (
    <KeyboardFrame key={fontScale}>
      <View style={styles.navigation}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to threads" onPress={onBack} style={styles.back}><SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={21} tintColor={colors.primary} /></Pressable>
        <View style={styles.heading}>
          <Text accessibilityRole="header" style={styles.threadTitle} numberOfLines={fontScale > 1.3 ? 2 : 1}>{session.title}</Text>
          <View style={styles.agentLine}><ConnectionMark state={connection} /><Text style={styles.agentName}>{agentName ?? 'Hermes'}{statusLabel ? ` · ${statusLabel}` : ''}</Text></View>
        </View>
        <ConnectionAction state={connection} onReconnect={onReconnect} onDetails={onAgentDetails} />
        <IconButton name="ellipsis" label="Thread actions" onPress={onSessionActions ?? (() => showSessionActions(session.title, [{ label: 'Threads', onPress: () => onBack?.() }]))} />
      </View>
      <LegendList
        ref={list}
        data={events}
        recycleItems
        keyExtractor={(item) => item.id}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        // Rows only re-render on data changes; the live activity label also reads the connection.
        extraData={connection}
        estimatedItemSize={100}
        drawDistance={500}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={isLoading ? <ActivityIndicator color={colors.cyan} accessibilityLabel="Loading messages" /> : <NewThreadEmpty />}
        initialScrollAtEnd
        maintainVisibleContentPosition
        // Keep the reading position when the keyboard resizes the viewport.
        maintainScrollAtEnd={following ? { on: { dataChange: true, itemLayout: true, layout: false } } : false}
        maintainScrollAtEndThreshold={0.15}
        onContentSizeChange={() => {
          if (following) requestAnimationFrame(() => list.current?.scrollToEnd({ animated: false }));
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onScrollBeginDrag={() => { clearTimeout(dragEndTimer.current); dragging.current = true; setFollowing((current) => followAfterScroll(current, 'begin', atEnd.current)); }}
        onScroll={(event) => {
          const { contentSize, contentOffset, layoutMeasurement } = event.nativeEvent;
          atEnd.current = contentSize.height - contentOffset.y - layoutMeasurement.height <= 2;
        }}
        onScrollEndDrag={() => { dragEndTimer.current = setTimeout(endScroll, 80); }}
        onMomentumScrollBegin={() => { clearTimeout(dragEndTimer.current); dragging.current = true; }}
        onMomentumScrollEnd={endScroll}
        scrollEventThrottle={32}
      />
      {!following && events.length > 0 ? <Pressable accessibilityRole="button" onPress={() => { dragging.current = false; setFollowing(true); list.current?.scrollToEnd({ animated: true }); }} style={styles.latest}><Text style={styles.link}>Jump to latest ↓</Text></Pressable> : null}
      {error ? <View style={styles.error} accessibilityRole="alert"><Text style={styles.errorText}>{error}</Text>{onRetryError ? <Pressable accessibilityRole="button" accessibilityLabel="Retry" disabled={isActing} onPress={onRetryError} style={{ minHeight: 44, justifyContent: "center" }}><Text style={styles.link}>Retry</Text></Pressable> : null}</View> : null}
      {queuedMessages.length > 0 ? <ScrollView style={styles.queue} keyboardShouldPersistTaps="handled">
        {queuedMessages.map((message) => <View key={message.id} style={styles.queueRow}>
          <View style={{ flex: 1 }}><Text style={styles.queueLabel}>{message.state === 'sending' ? 'Sending' : message.steeringRunId && !message.acceptedRunId ? 'Delivery unknown' : message.state === 'failed' ? 'Not sent' : 'Queued'}</Text><Text selectable numberOfLines={2} style={styles.queueText}>{message.text || message.attachments.map((file) => file.name).join(', ')}</Text>{message.error ? <Text style={styles.queueError}>{message.error}</Text> : null}</View>
          {onSteerQueued && canSteerMessage(message) ? <Pressable accessibilityRole="button" accessibilityLabel="Steer now" disabled={isActing || connection !== 'connected'} onPress={() => onSteerQueued(message.id)} style={styles.queueAction}><Text style={{ color: colors.cyan, fontSize: 13 }}>Steer now</Text></Pressable> : null}
          {message.state === 'failed' && !message.steeringRunId ? <Pressable accessibilityRole="button" accessibilityLabel="Retry queued message" onPress={() => onRetryQueued?.(message.id)} style={styles.queueAction}><Text style={styles.link}>Retry</Text></Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Copy queued message" style={styles.queueAction} onPress={() => { void Clipboard.setStringAsync(message.text).catch(() => Alert.alert("Could not copy", "Try again.")); }}><Text style={styles.link}>Copy</Text></Pressable>
          {message.state !== 'sending' ? <IconButton name="xmark" label="Remove queued message" onPress={() => onRemoveQueued?.(message.id)} /> : null}
        </View>)}
      </ScrollView> : null}
      {approval ? (
        <View style={styles.approval} accessibilityRole="alert">
          <ScrollView style={styles.approvalScroll} keyboardShouldPersistTaps="handled">
            <Text style={styles.approvalTitle}>{approval.title}</Text>
            {approval.reason ? <Text style={styles.approvalReason}>{approval.reason}</Text> : null}
            <Text style={styles.command} selectable>{approval.command}</Text>
          </ScrollView>
          <View style={styles.actions}>
            <Pressable style={[styles.action, (isActing || connection !== 'connected') && styles.disabled]} accessibilityRole="button" accessibilityLabel="Deny command" accessibilityState={{ disabled: isActing || connection !== 'connected' }} disabled={isActing || connection !== 'connected'} onPress={() => onDeny?.(approval)}><Text style={styles.buttonText}>Deny</Text></Pressable>
            <Pressable style={[styles.action, styles.allow, (isActing || connection !== 'connected') && styles.disabled]} accessibilityRole="button" accessibilityLabel="Allow command once" accessibilityState={{ disabled: isActing || connection !== 'connected' }} disabled={isActing || connection !== 'connected'} onPress={() => onApprove?.(approval)}><Text style={styles.darkText}>{isActing ? 'Sending…' : 'Allow once'}</Text></Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.composer}>
          {skillMenuTrigger ? <SkillMenu skills={skillMatches} loading={skillsLoading} error={skillsError} onRetry={onRefreshSkills} onSelect={chooseSkill} /> : null}
          <View style={expanded ? styles.composerField : styles.composerPill}>
            {expanded ? <AttachmentStrip files={attachments.map((file) => ({ ...file, source: { uri: file.uri } }))} onRemove={onRemoveAttachment} disabled={isActing || isPicking} /> : null}
            <TextInputWrapper style={expanded ? undefined : { flex: 1 }} onPaste={(payload) => { if (payload.type === 'images' && !isActing && !isPicking && !sendDisabled) onPasteImages?.(payload.uris); }}>
            <TextInput
              ref={input}
              // Grows from one line to five before scrolling while expanded.
              style={[expanded ? styles.input : styles.pillInput, { fontSize: 17 * factor, lineHeight: 23 * factor }, expanded ? { maxHeight: 23 * factor * 5 + 12 } : { height: pillHeight, paddingVertical: (pillHeight - 23 * factor) / 2 }]}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              value={draft}
              editable={!isActing}
              onChangeText={(value) => { setObservedSelection((previous) => previous ? { start: Math.min(previous.start, value.length), end: Math.min(previous.end, value.length), text: value } : previous); setInputSelection(undefined); setSkillsOpen(false); setSkillsDismissed(false); onDraftChange?.(value); }}
              multiline
              scrollEnabled={expanded}
              selection={inputSelection}
              onSelectionChange={(event) => { setObservedSelection({ ...event.nativeEvent.selection, text: draft }); setInputSelection(undefined); setSkillsDismissed(false); }}
              maxLength={8000}
              placeholder="Message"
              placeholderTextColor={colors.secondary}
              selectionColor={colors.cyan}
              accessibilityLabel="Message Hermes"
              accessibilityHint={connection !== 'connected' ? 'Messages are saved in the outbox until this agent reconnects.' : undefined}
            />
            </TextInputWrapper>
            {expanded ? <View style={styles.toolbar}>
              {onPickAttachments && Platform.OS !== 'web' ? (
                <MenuView
                  actions={[
                    { id: 'photos', title: 'Photos', image: 'photo', attributes: { disabled: isActing || isPicking } },
                    { id: 'files', title: 'Files', image: 'doc', attributes: { disabled: isActing || isPicking } },
                  ]}
                  onPressAction={(event) => onPickAttachments(event.nativeEvent.event === 'photos' ? 'photos' : 'files')}
                  style={styles.nativeMenu}
                >
                  <ComposerIcon name="plus" label="Add attachments" disabled={isActing || isPicking} />
                </MenuView>
              ) : <ComposerIcon name="plus" label="Add attachments" disabled={isActing || isPicking} onPress={onAddAttachments} />}
              <ComposerIcon
                name="shippingbox"
                label={selectedSkills.length ? `Skills, ${selectedSkills.length} selected` : 'Skills'}
                selected={Boolean(skillMenuTrigger)}
                disabled={isActing}
                onPress={() => {
                  if (skillMenuTrigger) {
                    setSkillsOpen(false);
                    setSkillsDismissed(true);
                  } else {
                    setSkillsOpen(true);
                    setSkillsDismissed(false);
                    requestAnimationFrame(() => input.current?.focus());
                  }
                }}
              />
              {activeModel ? (
                <Pressable accessibilityRole="button" accessibilityLabel={`Model, ${activeModel}`} onPress={() => setModelOpen(true)} style={({ pressed }) => [styles.modelButton, { opacity: pressed ? 0.6 : 1 }]}>
                  <Text numberOfLines={1} style={styles.modelLabel}>{shortModelName(activeModel)}</Text>
                </Pressable>
              ) : null}
              <View style={styles.toolbarSpacer} />
              {action}
            </View> : action}
          </View>
        </View>
      )}
      <Modal visible={modelOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setModelOpen(false)}>
        <View style={styles.modelSheet}>
          <View style={styles.modelSheetHeader}>
            <Text style={styles.modelSheetTitle}>Model</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close model picker" onPress={() => setModelOpen(false)} style={styles.modelSheetClose}><Text style={styles.modelSheetCloseText}>Close</Text></Pressable>
          </View>
          <ModelPicker models={models} defaultModel={defaultModel} selected={selectedModel} selectedProvider={selectedProvider} disabled={isActing} loading={modelsLoading} onSelect={(model) => { onSelectModel?.(model); setModelOpen(false); }} />
        </View>
      </Modal>
    </KeyboardFrame>
  );
}

/** Short display name for a Hermes model id. The full id stays visible inside the picker. */
function shortModelName(modelId: string): string {
  const tail = modelId.split('/').pop() ?? modelId;
  return tail.split(':')[0] || modelId;
}

function ComposerIcon({ name, label, disabled = false, selected = false, onPress }: { name: 'plus' | 'shippingbox'; label: string; disabled?: boolean; selected?: boolean; onPress?: () => void }) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.composerIcon, selected && styles.composerIconSelected, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
    <SymbolView name={{ ios: name, android: name === 'plus' ? 'add' : 'deployed_code', web: name === 'plus' ? 'add' : 'deployed_code' }} size={20} tintColor={selected ? colors.primary : colors.secondary} />
  </Pressable>;
}

// The composer's corner radius; action buttons sit inset by their padding so their curves stay concentric.
const COMPOSER_RADIUS = 22;
const PILL_INSET = 5;
const FIELD_INSET = 6;
const COLLAPSED_ACTION = (COMPOSER_RADIUS - PILL_INSET) * 2;
const EXPANDED_ACTION = (COMPOSER_RADIUS - FIELD_INSET) * 2;

function ComposerAction({ kind, size, label, disabled, onPress }: { kind: 'send' | 'stop'; size: number; label?: string; disabled: boolean; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const stop = kind === 'stop';
  const slop = Math.max(0, (44 - size) / 2);
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={stop ? 'Stop run' : label}
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={onPress}
    hitSlop={slop}
    style={({ pressed }) => [styles.composerAction, { width: size, height: size, borderRadius: size / 2, backgroundColor: stop ? colors.red : disabled ? colors.lineStrong : colors.primary, opacity: pressed ? 0.7 : stop && disabled ? 0.5 : 1 }]}
  >
    <SymbolView name={{ ios: stop ? 'stop.fill' : 'arrow.up', android: stop ? 'stop' : 'arrow_upward', web: stop ? 'stop' : 'arrow_upward' }} size={stop ? 12 : 16} weight="semibold" tintColor={stop ? colors.primary : disabled ? colors.secondary : colors.background} />
  </Pressable>;
}

function NewThreadEmpty() {
  const styles = useThemedStyles(createStyles);
  return <View style={styles.empty}><Text style={styles.emptyTitle}>How can I help?</Text></View>;
}

function SkillMenu({ skills, loading, error, onRetry, onSelect }: { skills: readonly HermesSkill[]; loading: boolean; error?: string; onRetry?: () => void; onSelect: (skill: HermesSkill) => void }) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  return <View style={styles.skillMenu}>
    {loading ? <View style={styles.skillLoading}><ActivityIndicator size="small" color={colors.secondary} accessibilityLabel="Loading skills" /></View> : null}
    {error ? <Pressable accessibilityRole="button" onPress={onRetry} style={styles.skillStatus}><Text style={styles.skillError}>{error}</Text><Text style={styles.skillRetry}>Retry</Text></Pressable>
      : skills.length ? <ScrollView style={styles.skillList} keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={false}>
        {skills.map((skill) => <Pressable key={skill.name} accessibilityRole="button" accessibilityLabel={`Use skill ${skill.name}`} onPress={() => onSelect(skill)} style={({ pressed }) => [styles.skillRow, { opacity: pressed ? 0.6 : 1 }]}>
          <Text style={styles.skillName}>${skill.name}</Text>
          {skill.description ? <Text numberOfLines={1} style={styles.skillDescription}>{skill.description}</Text> : null}
        </Pressable>)}
      </ScrollView> : !loading ? <View style={styles.skillStatus}><Text style={styles.skillDescription}>No skills available.</Text>{onRetry ? <Pressable accessibilityRole="button" onPress={onRetry}><Text style={styles.skillRetry}>Refresh</Text></Pressable> : null}</View> : null}
  </View>;
}

const TranscriptEntry = memo(function TranscriptEntry({ row, agentName, attachmentSource }: { row: Exclude<TranscriptRow, TranscriptActivityRow>; agentName: string; attachmentSource?: (id: string) => AttachmentSource | undefined }) {
  const styles = useThemedStyles(createStyles);
  const { factor } = useTextScale();
  const colors = useColors();
  if (row.kind === 'error') return <View style={styles.error} accessibilityRole="alert"><Text selectable style={styles.errorText}>{row.text}</Text></View>;
  const user = row.kind === 'user';
  // An agent row without content has nothing to show and only eats vertical space.
  if (!user && !row.text.trim()) return null;
  const message = user ? splitAttachmentMessage(row.text) : undefined;
  return <View style={styles.message}>
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.avatar, user && styles.userAvatar]}><Text style={[styles.avatarText, user && { color: colors.primary }]}>{user ? 'Y' : agentName.charAt(0).toUpperCase()}</Text></View>
    <View style={styles.messageBody}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}><Text style={[styles.author, { fontSize: 14 * factor }]}>{user ? 'You' : agentName}</Text>{user ? <CopyButton text={message?.text ?? row.text} /> : null}</View>
      {message ? <>{message.text ? <Text selectable style={[styles.userText, { fontSize: 16 * factor, lineHeight: 24 * factor }]}>{message.text}</Text> : null}<AttachmentStrip files={message.attachments.map((file) => ({ ...file, source: attachmentSource?.(file.id) }))} /></> : <MessageContent text={row.text} />}
    </View>
  </View>;
});

// Whole wall-clock seconds as an external store, so a recycled row never renders a stale time.
const secondsNow = () => Math.floor(Date.now() / 1000);
const tickEverySecond = (onTick: () => void) => {
  const timer = setInterval(onTick, 1000);
  return () => clearInterval(timer);
};
const noTicks = () => () => undefined;

/** Wall-clock seconds, re-rendering once a second only while `active`. */
function useNow(active: boolean): number {
  return useSyncExternalStore(active ? tickEverySecond : noTicks, secondsNow);
}

// One row per turn: a live status while running, then a fold like "Worked for 42s · 6 steps".
const ActivityEntry = memo(function ActivityEntry({ row, connection, onDisclosure }: { row: TranscriptActivityRow; connection: ConnectionState; onDisclosure: () => void }) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const [expanded, setExpanded] = useRecyclingState(false);
  const running = row.status === 'running';
  const now = useNow(running);
  const label = running ? liveActivityLabel(row, connection) : settledActivityLabel(row);
  const seconds = running ? elapsed(row.startedAt, now) : undefined;
  const expandable = row.steps.length > 0;
  const attention = running && (row.phase === 'approval' || connection !== 'connected');
  return <View style={styles.activity}>
    <Pressable
      style={styles.activityToggle}
      disabled={!expandable}
      accessibilityRole={expandable ? 'button' : 'text'}
      accessibilityLabel={seconds === undefined ? label : `${label}, ${formatDuration(seconds)}`}
      accessibilityState={expandable ? { expanded } : undefined}
      onPress={() => { onDisclosure(); setExpanded(!expanded); }}
    >
      {running ? <RingSpinner color={attention ? colors.amber : colors.secondary} /> : null}
      <Text style={[styles.activityLabel, row.status === 'failed' && styles.failedText, attention && styles.attentionText]} numberOfLines={1} ellipsizeMode="middle">{label}</Text>
      {seconds !== undefined ? <Text style={styles.activityTime}>{formatDuration(seconds)}</Text> : null}
      {expandable ? <SymbolView name={{ ios: expanded ? 'chevron.up' : 'chevron.down', android: expanded ? 'expand_less' : 'expand_more', web: expanded ? 'expand_less' : 'expand_more' }} size={10} tintColor={colors.secondary} /> : null}
    </Pressable>
    {expanded ? row.steps.map((step) => <StepEntry key={step.id} step={step} onDisclosure={onDisclosure} />) : null}
  </View>;
});

const MAX_DETAIL = 4000;

function clip(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

// A flat timeline line: verb, target, and duration or failure. Tapping shows the full input and output.
const StepEntry = memo(function StepEntry({ step, onDisclosure }: { step: TranscriptStep; onDisclosure: () => void }) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const [open, setOpen] = useState(false);
  if (step.kind === 'note') return <Text selectable style={styles.note}>{step.text.trim()}</Text>;
  const tool = step.kind === 'tool' ? step : undefined;
  const verb = tool ? toolVerb(tool.name, tool.status) : 'Thought';
  const target = oneLine(step.kind === 'tool' ? step.input || step.output : step.text);
  const failed = tool?.status === 'failed';
  const trailing = tool?.status === 'running' ? <RingSpinner size={12} color={colors.muted} />
    : failed ? <Text style={[styles.stepTime, styles.failedText]}>Failed</Text>
      : tool?.duration !== undefined && tool.duration >= 1 ? <Text style={styles.stepTime}>{formatDuration(tool.duration)}</Text> : null;
  return <View>
    <Pressable
      style={styles.step}
      disabled={!target}
      accessibilityRole="button"
      accessibilityLabel={[verb, target, failed ? 'failed' : undefined].filter(Boolean).join(', ')}
      accessibilityState={{ expanded: open }}
      onPress={() => { onDisclosure(); setOpen(!open); }}
    >
      <Text style={[styles.stepVerb, failed && styles.failedText]}>{verb}</Text>
      {/* Paths and commands keep both ends; prose reads from the start. */}
      <Text style={styles.stepTarget} numberOfLines={1} ellipsizeMode={step.kind === 'tool' ? 'middle' : 'tail'}>{target}</Text>
      {trailing}
    </Pressable>
    {open ? <View style={styles.stepDetail}>
      {step.kind === 'tool' ? <>
        {step.input ? <Text selectable style={styles.stepInput}>{clip(step.input)}</Text> : null}
        {step.output ? <Text selectable style={styles.stepOutput}>{clip(readableOutput(step.output))}</Text> : null}
      </> : <Text selectable style={styles.note}>{clip(step.text.trim())}</Text>}
    </View> : null}
  </View>;
});

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  queue: { flexGrow: 0, maxHeight: 160, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  queueRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 8 },
  queueLabel: { color: colors.secondary, fontSize: 12, marginBottom: 3 },
  queueText: { color: colors.primary, fontSize: 14, lineHeight: 20 },
  queueError: { color: colors.red, fontSize: 12, lineHeight: 17, marginTop: 4 },
  queueAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  queueSend: { minHeight: 44, minWidth: 58, backgroundColor: colors.primary, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },

  navigation: { backgroundColor: colors.chrome, minHeight: 64, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  back: { minHeight: 44, width: 32, justifyContent: 'center', alignItems: 'center' },
  heading: { flex: 1, paddingVertical: 8, gap: 4 },
  threadTitle: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  agentLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  agentName: { flexShrink: 1, color: colors.secondary, fontSize: 12 },
  listContent: { paddingHorizontal: 12, paddingTop: 20, paddingBottom: 16 },
  userText: { color: colors.primary, fontSize: 16, lineHeight: 24 },
  message: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.cyan, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  userAvatar: { backgroundColor: colors.userBubble },
  avatarText: { color: colors.accentForeground, fontSize: 13, fontWeight: '700' },
  messageBody: { flex: 1, minWidth: 0, gap: 4 },
  author: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  activity: { marginLeft: 40, marginTop: -8, marginBottom: 12 },
  activityToggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  activityLabel: { flexShrink: 1, color: colors.secondary, fontSize: 13 },
  activityTime: { color: colors.muted, fontSize: 13, fontVariant: ['tabular-nums'] },
  attentionText: { color: colors.amber },
  failedText: { color: colors.red },
  step: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepVerb: { color: colors.muted, fontSize: 13 },
  stepTarget: { flex: 1, color: colors.secondary, fontSize: 13 },
  stepTime: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  stepDetail: { marginBottom: 10, paddingLeft: 12, paddingVertical: 4, borderLeftWidth: 1, borderLeftColor: colors.lineStrong, gap: 8 },
  stepInput: { color: colors.primary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 18 },
  stepOutput: { color: colors.secondary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 18 },
  note: { color: colors.secondary, fontSize: 13, lineHeight: 19, paddingVertical: 6 },
  latest: { alignSelf: 'center', paddingHorizontal: 16, minHeight: 44, justifyContent: 'center' },
  link: { color: colors.cyan, fontSize: 14 },
  error: { padding: 14, borderLeftWidth: 2, borderLeftColor: colors.red },
  errorText: { color: colors.red, fontSize: 14, lineHeight: 20 },
  approval: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingHorizontal: 16, paddingVertical: 16, gap: 14 },
  approvalScroll: { maxHeight: 220 },
  approvalTitle: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  approvalReason: { color: colors.secondary, fontSize: 14, lineHeight: 20, marginTop: 8 },
  command: { color: colors.primary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 20, marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, paddingVertical: 12 },
  actions: { flexDirection: 'row', gap: 12 },
  action: { flex: 1, minHeight: 48, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.background },
  allow: { backgroundColor: colors.primary },
  darkText: { color: colors.background, fontSize: 15, fontWeight: '600' },
  buttonText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  composer: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  composerField: { backgroundColor: colors.composer, borderRadius: COMPOSER_RADIUS, paddingHorizontal: FIELD_INSET, paddingTop: 10, paddingBottom: FIELD_INSET },
  composerPill: { backgroundColor: colors.composer, borderRadius: COMPOSER_RADIUS, padding: PILL_INSET, paddingLeft: 14, flexDirection: 'row', alignItems: 'center', gap: 8 },
  pillInput: { color: colors.primary, flex: 1, paddingHorizontal: 0 },
  composerAction: { alignItems: 'center', justifyContent: 'center' },
  input: { color: colors.primary, fontSize: 17, lineHeight: 23, minHeight: 44, paddingVertical: 6, paddingHorizontal: 8, textAlignVertical: 'top' },
  toolbar: { minHeight: EXPANDED_ACTION, flexDirection: 'row', alignItems: 'center', gap: 2 },
  toolbarSpacer: { flex: 1 },
  modelButton: { minHeight: 44, maxWidth: 140, paddingHorizontal: 10, justifyContent: 'center' },
  modelLabel: { color: colors.secondary, fontSize: 13 },
  modelSheet: { flex: 1, backgroundColor: colors.background, paddingTop: 16 },
  modelSheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, minHeight: 44 },
  modelSheetTitle: { color: colors.primary, fontSize: 17, fontWeight: '600' },
  modelSheetClose: { minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'center' },
  modelSheetCloseText: { color: colors.cyan, fontSize: 15, fontWeight: '600' },
  nativeMenu: { width: 44, height: 44 },
  composerIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  composerIconSelected: { backgroundColor: colors.lineStrong },
  skillMenu: { maxHeight: 216, overflow: 'hidden', backgroundColor: colors.elevated, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong },
  skillLoading: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  skillList: { maxHeight: 180 },
  skillRow: { minHeight: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  skillName: { color: colors.primary, fontSize: 14, fontWeight: '600', maxWidth: '48%' },
  skillDescription: { color: colors.secondary, fontSize: 12, flex: 1 },
  skillStatus: { minHeight: 48, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  skillError: { color: colors.red, fontSize: 12, flex: 1 },
  skillRetry: { color: colors.cyan, fontSize: 13, fontWeight: '600' },
  empty: { paddingTop: 72, paddingHorizontal: 24, alignItems: 'center', gap: 12 },
  emptyTitle: { color: colors.primary, fontSize: 28, fontWeight: '700', textAlign: 'center' },
});
