import { splitAttachmentMessage, type AttachmentSource, type DraftAttachment } from '../../lib/attachments';
import { AttachmentStrip } from './attachment-strip';
import { memo, useCallback, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { LegendList, useRecyclingState, type LegendListRef } from '@legendapp/list/react-native';

import { ConnectionAction, ConnectionMark, IconButton, relayColors as colors, styles as uiStyles } from './relay-ui';
import { showSessionActions } from './session-actions';
import { MessageContent } from './message-content';
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
  onRemoveAttachment?: (id: string) => void;
  attachmentSource?: (id: string) => AttachmentSource | undefined;
  agentName?: string;
  isSending?: boolean;
  isLoading?: boolean;
  isActing?: boolean;
  statusLabel?: string;
  error?: string;
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

export function RunScreen({ session, events, connection, approval, draft = '', attachments = [], isPicking = false, onAddAttachments, onRemoveAttachment, attachmentSource, agentName, isSending = false, isLoading = false, isActing = false, statusLabel, error, onBack, onSessionActions, onDraftChange, onSend, onStop, onReconnect, onAgentDetails, onApprove, onDeny }: RunScreenProps) {
  const { fontScale } = useWindowDimensions();
  const list = useRef<LegendListRef>(null);
  const dragging = useRef(false);
  const [following, setFollowing] = useState(true);
  const suspendFollow = useCallback(() => setFollowing(false), []);
  const renderItem = useCallback(({ item }: { item: TranscriptRow }) => <TranscriptEntry row={item} agentName={agentName ?? 'Hermes'} attachmentSource={attachmentSource} onDisclosure={suspendFollow} />, [suspendFollow, agentName, attachmentSource]);
  const canSend = connection === 'connected' && !isSending && !isActing && !isPicking && Boolean(draft.trim() || attachments.length);
  return (
    <KeyboardAvoidingView key={fontScale} style={uiStyles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.navigation}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to threads" onPress={onBack} style={styles.back}><SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={21} tintColor={colors.primary} /></Pressable>
        <View style={styles.heading}>
          <Text accessibilityRole="header" style={styles.threadTitle} numberOfLines={fontScale > 1.3 ? 2 : 1}># {session.title}</Text>
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
        ListEmptyComponent={isLoading ? <ActivityIndicator color={colors.cyan} accessibilityLabel="Loading messages" /> : <View style={styles.empty}><Text style={styles.emptyTitle}>What should Hermes do?</Text><Text style={styles.emptyText}>Add links or code for context.</Text></View>}
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
          <AttachmentStrip files={attachments.map((file) => ({ ...file, source: { uri: file.uri } }))} onRemove={onRemoveAttachment} disabled={isActing || isPicking} />
          <View style={styles.composerField}>
            <Pressable accessibilityRole="button" accessibilityLabel="Add attachments" accessibilityState={{ disabled: isActing || isPicking }} disabled={isActing || isPicking} onPress={onAddAttachments} style={styles.attachButton}><SymbolView name={{ ios: 'plus', android: 'add', web: 'add' }} size={22} tintColor={isActing || isPicking ? colors.muted : colors.secondary} /></Pressable>
            <View style={styles.inputSlot}>
            <TextInput
              style={styles.input}
              value={draft}
              editable={!isActing}
              onChangeText={onDraftChange}
              multiline={false}
              returnKeyType="send"
              submitBehavior="submit"
              onSubmitEditing={() => { if (canSend) onSend(draft.trim()); }}
              maxLength={8000}
              placeholderTextColor={colors.secondary}
              selectionColor={colors.cyan}
              accessibilityLabel="Message Hermes"
              accessibilityHint={connection !== 'connected' ? 'Drafts are saved. Reconnect to send.' : undefined}
            />
            {!draft ? <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.placeholderContainer}>
              <Text numberOfLines={1} ellipsizeMode="tail" style={styles.placeholder}>Message #{session.title === 'New thread' ? 'new-thread' : session.title}</Text>
            </View> : null}
            </View>
            {isSending ? <IconButton name="stop.fill" label="Stop run" tone="destructive" disabled={isActing || connection !== 'connected'} onPress={onStop} />
              : <IconButton name="arrow.up" label={isActing ? 'Sending message' : 'Send message'} tone="primary" disabled={!canSend} onPress={() => onSend(draft.trim())} />}
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const TranscriptEntry = memo(function TranscriptEntry({ row, agentName, attachmentSource, onDisclosure }: { row: TranscriptRow; agentName: string; attachmentSource?: (id: string) => AttachmentSource | undefined; onDisclosure: () => void }) {
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
      <Text style={styles.author}>{user ? 'You' : agentName}</Text>
      {message ? <>{message.text ? <Text selectable style={styles.userText}>{message.text}</Text> : null}<AttachmentStrip files={message.attachments.map((file) => ({ ...file, source: attachmentSource?.(file.id) }))} /></> : <MessageContent text={row.text} />}
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
  composer: { paddingHorizontal: 12, paddingVertical: 8 },
  composerField: { backgroundColor: '#1c1d22', borderRadius: 22, paddingLeft: 4, paddingRight: 4, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 4 },
  attachButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  inputSlot: { flex: 1, minWidth: 0 },
  input: { color: colors.primary, fontSize: 16, lineHeight: 22, minHeight: 44, paddingVertical: 11, paddingHorizontal: 0 },
  placeholderContainer: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, justifyContent: 'center' },
  placeholder: { color: colors.secondary, fontSize: 16, lineHeight: 22 },
  empty: { paddingTop: 36, gap: 10 },
  emptyTitle: { color: colors.primary, fontSize: 24, fontWeight: '600' },
  emptyText: { color: colors.secondary, fontSize: 15, lineHeight: 22, maxWidth: 300 },
});
