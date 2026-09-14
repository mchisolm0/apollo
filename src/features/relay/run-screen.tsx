import { splitAttachmentMessage, type AttachmentSource, type DraftAttachment } from '../../lib/attachments';
import { AttachmentStrip } from './attachment-strip';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { MenuView } from '@expo/ui/community/menu';
import { LegendList, useRecyclingState, type LegendListRef } from '@legendapp/list/react-native';

import { ConnectionAction, ConnectionMark, IconButton, relayColors as colors, useTextScale } from './relay-ui';
import { KeyboardFrame } from './keyboard-frame';
import { insertSkill, matchingSkills, selectedSkillNames, skillTrigger, type SkillTrigger } from './composer-skills';
import { showSessionActions } from './session-actions';
import { MessageContent } from './message-content';
import { ModelPicker } from './model-picker';
import type { HermesModel, HermesSkill } from '../../lib/types';
import type { ApprovalRequest, ConnectionState, RelaySession } from './types';
import { friendlyToolName, type TranscriptRow, type TranscriptTool } from './transcript';

export type RunScreenProps = {
  session: RelaySession;
  events: readonly TranscriptRow[];
  connection: ConnectionState;
  approval?: ApprovalRequest;
  draft?: string;
  attachments?: readonly DraftAttachment[];
  isPicking?: boolean;
  onAddAttachments?: () => void;
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
  onSelectModel?: (modelId: string) => void;
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

export function RunScreen({ session, events, connection, approval, draft = '', attachments = [], isPicking = false, onAddAttachments, onPickAttachments, onRemoveAttachment, attachmentSource, agentName, isSending = false, isLoading = false, isActing = false, statusLabel, error, skills = [], skillsLoading = false, skillsError, onRefreshSkills, models = [], modelsLoading = false, defaultModel, selectedModel, onSelectModel, onBack, onSessionActions, onDraftChange, onSend, onStop, onReconnect, onAgentDetails, onApprove, onDeny }: RunScreenProps) {
  const { fontScale } = useWindowDimensions();
  const { factor } = useTextScale();
  const list = useRef<LegendListRef>(null);
  const input = useRef<TextInput>(null);
  const dragging = useRef(false);
  const [following, setFollowing] = useState(true);
  const [observedSelection, setObservedSelection] = useState<{ start: number; end: number; text: string }>();
  const [inputSelection, setInputSelection] = useState<{ start: number; end: number }>();
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsDismissed, setSkillsDismissed] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const activeModel = selectedModel ?? defaultModel ?? models[0]?.id;
  const selection = observedSelection?.text === draft
    ? { start: Math.min(observedSelection.start, draft.length), end: Math.min(observedSelection.end, draft.length) }
    : { start: draft.length, end: draft.length };
  const suspendFollow = useCallback(() => setFollowing(false), []);
  const renderItem = useCallback(({ item }: { item: TranscriptRow }) => <TranscriptEntry row={item} agentName={agentName ?? 'Hermes'} attachmentSource={attachmentSource} onDisclosure={suspendFollow} />, [suspendFollow, agentName, attachmentSource]);
  const canSend = connection === 'connected' && !isSending && !isActing && !isPicking && Boolean(draft.trim() || attachments.length);
  const typedSkill = selection.start === selection.end ? skillTrigger(draft, selection.end) : undefined;
  const skillMenuTrigger: SkillTrigger | undefined = !skillsDismissed ? typedSkill ?? (skillsOpen ? { query: '', start: selection.end, end: selection.end } : undefined) : undefined;
  const skillMatches = matchingSkills(skillMenuTrigger, skills);
  const selectedSkills = useMemo(() => selectedSkillNames(draft, skills), [draft, skills]);
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
        estimatedItemSize={100}
        drawDistance={500}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={isLoading ? <ActivityIndicator color={colors.cyan} accessibilityLabel="Loading messages" /> : <NewThreadEmpty agentName={agentName ?? 'Hermes'} connection={connection} />}
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
        onScrollBeginDrag={() => { dragging.current = true; setFollowing(false); }}
        onScroll={(event) => {
          if (!dragging.current) return;
          const { contentSize, contentOffset, layoutMeasurement } = event.nativeEvent;
          setFollowing(contentSize.height - contentOffset.y - layoutMeasurement.height < 60);
        }}
        onMomentumScrollEnd={() => { dragging.current = false; }}
        scrollEventThrottle={32}
      />
      {!following && events.length > 0 ? <Pressable accessibilityRole="button" onPress={() => { dragging.current = false; setFollowing(true); list.current?.scrollToEnd({ animated: true }); }} style={styles.latest}><Text style={styles.link}>Jump to latest ↓</Text></Pressable> : null}
      {error ? <View style={styles.error} accessibilityRole="alert"><Text style={styles.errorText}>{error}</Text></View> : null}
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
          <View style={styles.composerField}>
            <AttachmentStrip files={attachments.map((file) => ({ ...file, source: { uri: file.uri } }))} onRemove={onRemoveAttachment} disabled={isActing || isPicking} />
            <TextInput
              ref={input}
              style={[styles.input, { fontSize: 17 * factor, lineHeight: 23 * factor }]}
              value={draft}
              editable={!isActing}
              onChangeText={(value) => { setObservedSelection((previous) => previous ? { start: Math.min(previous.start, value.length), end: Math.min(previous.end, value.length), text: value } : previous); setInputSelection(undefined); setSkillsOpen(false); setSkillsDismissed(false); onDraftChange?.(value); }}
              multiline
              scrollEnabled
              selection={inputSelection}
              onSelectionChange={(event) => { setObservedSelection({ ...event.nativeEvent.selection, text: draft }); setInputSelection(undefined); setSkillsDismissed(false); }}
              maxLength={8000}
              placeholder={`Message ${agentName ?? 'Hermes'}`}
              placeholderTextColor={colors.secondary}
              selectionColor={colors.cyan}
              accessibilityLabel="Message Hermes"
              accessibilityHint={connection !== 'connected' ? 'Drafts are saved. Reconnect to send.' : undefined}
            />
            <View style={styles.toolbar}>
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
              {isSending ? <IconButton name="stop.fill" label="Stop run" tone="destructive" disabled={isActing || connection !== 'connected'} onPress={onStop} />
                : <IconButton name="arrow.up" label={isActing ? 'Sending message' : 'Send message'} tone="primary" disabled={!canSend} onPress={() => onSend(draft.trim())} />}
            </View>
          </View>
        </View>
      )}
      <Modal visible={modelOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setModelOpen(false)}>
        <View style={styles.modelSheet}>
          <View style={styles.modelSheetHeader}>
            <Text style={styles.modelSheetTitle}>Model</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close model picker" onPress={() => setModelOpen(false)} style={styles.modelSheetClose}><Text style={styles.modelSheetCloseText}>Close</Text></Pressable>
          </View>
          <ModelPicker models={models} defaultModel={defaultModel} selected={selectedModel} loading={modelsLoading} onSelect={(id) => { onSelectModel?.(id); setModelOpen(false); }} />
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
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.composerIcon, selected && styles.composerIconSelected, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
    <SymbolView name={{ ios: name, android: name === 'plus' ? 'add' : 'deployed_code', web: name === 'plus' ? 'add' : 'deployed_code' }} size={20} tintColor={selected ? colors.primary : colors.secondary} />
  </Pressable>;
}

function NewThreadEmpty({ agentName, connection }: { agentName: string; connection: ConnectionState }) {
  return <View style={styles.empty}>
    <Text style={styles.emptyTitle}>What should we build in {agentName}?</Text>
    <View style={styles.emptyAgent}><ConnectionMark state={connection} /><Text style={styles.emptyAgentName}>{agentName}</Text></View>
  </View>;
}

function SkillMenu({ skills, loading, error, onRetry, onSelect }: { skills: readonly HermesSkill[]; loading: boolean; error?: string; onRetry?: () => void; onSelect: (skill: HermesSkill) => void }) {
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

const TranscriptEntry = memo(function TranscriptEntry({ row, agentName, attachmentSource, onDisclosure }: { row: TranscriptRow; agentName: string; attachmentSource?: (id: string) => AttachmentSource | undefined; onDisclosure: () => void }) {
  const { factor } = useTextScale();
  const [expanded, setExpanded] = useRecyclingState(false);
  if (row.kind === 'work') {
    const running = row.items.filter((tool) => tool.status === 'running');
    const failed = row.items.filter((tool) => tool.status === 'failed');
    const countLabel = row.items.some((tool) => tool.name === 'Progress update') ? 'activity updates' : row.items.length === 1 ? 'tool call' : 'tool calls';
    const label = running.length ? `Working · ${friendlyToolName(running[0].name)}` : failed.length ? `${failed.length} failed · ${row.items.length} tool calls` : `${row.items.length} ${countLabel}`;
    return <View style={styles.work}>
      <Pressable style={styles.workToggle} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded }} onPress={() => { onDisclosure(); setExpanded(!expanded); }}>
        {running.length ? <ActivityIndicator size="small" color={colors.secondary} /> : <SymbolView name={{ ios: 'terminal', android: 'terminal', web: 'terminal' }} size={14} tintColor={failed.length ? colors.red : colors.secondary} />}
        <Text style={[styles.workText, failed.length > 0 && styles.failedTool]}>{label}</Text>
        <Text style={styles.workText}>{expanded ? '⌃' : '⌄'}</Text>
      </Pressable>
      {expanded ? row.items.map((tool) => <ToolEntry key={tool.id} tool={tool} onDisclosure={onDisclosure} />) : null}
    </View>;
  }
  if (row.kind === 'error') return <View style={styles.error} accessibilityRole="alert"><Text selectable style={styles.errorText}>{row.text}</Text></View>;
  const user = row.kind === 'user';
  const message = user ? splitAttachmentMessage(row.text) : undefined;
  return <View style={styles.message}>
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.avatar, user && styles.userAvatar]}><Text style={styles.avatarText}>{user ? 'Y' : agentName.charAt(0).toUpperCase()}</Text></View>
    <View style={styles.messageBody}>
      <Text style={[styles.author, { fontSize: 14 * factor }]}>{user ? 'You' : agentName}</Text>
      {message ? <>{message.text ? <Text selectable style={[styles.userText, { fontSize: 16 * factor, lineHeight: 24 * factor }]}>{message.text}</Text> : null}<AttachmentStrip files={message.attachments.map((file) => ({ ...file, source: attachmentSource?.(file.id) }))} /></> : <MessageContent text={row.text} />}
    </View>
  </View>;
});

const ToolEntry = memo(function ToolEntry({ tool, onDisclosure }: { tool: TranscriptTool; onDisclosure: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const name = friendlyToolName(tool.name);
  const preview = tool.text.trim().replace(/\s+/g, ' ');
  const failed = tool.status === 'failed';
  const running = tool.status === 'running';
  return <View>
    <Pressable style={styles.toolToggle} accessibilityRole="button" accessibilityLabel={`${name}, ${tool.status}${preview ? `, ${preview.slice(0, 160)}` : ''}`} accessibilityState={{ expanded }} onPress={() => { onDisclosure(); setExpanded(!expanded); }}>
      <SymbolView name={{ ios: 'terminal', android: 'terminal', web: 'terminal' }} size={14} tintColor={colors.muted} />
      <Text style={[styles.toolName, failed && styles.failedTool]} numberOfLines={1}>{name}</Text>
      <Text style={styles.toolPreview} numberOfLines={1}>{preview}</Text>
      <SymbolView name={{ ios: expanded ? 'chevron.up' : 'chevron.down', android: expanded ? 'expand_less' : 'expand_more', web: expanded ? 'expand_less' : 'expand_more' }} size={10} tintColor={colors.secondary} />
      {running ? <ActivityIndicator size="small" color={colors.secondary} /> : <SymbolView name={{ ios: failed ? 'exclamationmark' : 'checkmark', android: failed ? 'priority_high' : 'check', web: failed ? 'priority_high' : 'check' }} size={12} tintColor={failed ? colors.red : colors.secondary} />}
    </Pressable>
    {expanded ? <View style={styles.toolDetails}><Text style={styles.toolStatus}>{running ? 'Running' : failed ? 'Failed' : 'Complete'}</Text><Text style={styles.toolOutput} selectable>{tool.text || 'No output'}</Text></View> : null}
  </View>;
});

const styles = StyleSheet.create({
  navigation: { minHeight: 64, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  back: { minHeight: 44, width: 32, justifyContent: 'center', alignItems: 'center' },
  heading: { flex: 1, paddingVertical: 8, gap: 4 },
  threadTitle: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  agentLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  agentName: { flexShrink: 1, color: colors.secondary, fontSize: 12 },
  listContent: { paddingHorizontal: 12, paddingTop: 20, paddingBottom: 16 },
  userText: { color: colors.primary, fontSize: 16, lineHeight: 24 },
  message: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#5865f2', alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  userAvatar: { backgroundColor: '#3d414b' },
  avatarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  messageBody: { flex: 1, minWidth: 0, gap: 4 },
  author: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  work: { marginLeft: 40, marginBottom: 12 },
  workToggle: { minHeight: 44, flexDirection: 'row', gap: 8, alignItems: 'center' },
  workText: { color: colors.secondary, fontSize: 13 },
  toolToggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7 },
  toolName: { color: '#d5d5d5', fontSize: 13, maxWidth: '45%', flexShrink: 1 },
  toolPreview: { color: colors.muted, fontSize: 13, flex: 1 },
  failedTool: { color: '#f18c94' },
  toolDetails: { marginLeft: 7, paddingLeft: 15, marginBottom: 14, paddingVertical: 6, borderLeftWidth: 1, borderLeftColor: colors.lineStrong, gap: 8 },
  toolStatus: { color: colors.secondary, fontSize: 12 },
  toolOutput: { color: colors.secondary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 19 },
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
  composerField: { backgroundColor: '#1c1d22', borderRadius: 20, paddingHorizontal: 6, paddingTop: 10, paddingBottom: 4 },
  input: { color: colors.primary, fontSize: 17, lineHeight: 23, minHeight: 44, maxHeight: 144, paddingVertical: 6, paddingHorizontal: 8, textAlignVertical: 'top' },
  toolbar: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 2 },
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
  emptyAgent: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  emptyAgentName: { color: colors.secondary, fontSize: 13 },
});
