import { HAS_MAIL_TOOLBAR, MAIL_TOOLBAR_INSET, MailToolbar } from './mail-toolbar';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LegendList } from '@legendapp/list/react-native';
import Swipeable, { SwipeDirection, type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

import { useTextScale, useThemedStyles, useColors, type RelayPalette } from './relay-ui';
import { isLargeText } from './text-size';
import { KeyboardFrame } from './keyboard-frame';
import { canSettleSession, isSessionSnoozed, type InboxSession } from './session-inbox';
import { useAutoSettleLedger, useSnoozeLedger } from './use-session-inbox';
import type { ConnectionState } from './types';
import { showSnoozeMenu, showThreadMenu } from './session-actions';
import { UndoToast, useUndoToast } from './undo-toast';
import { CustomSnoozeSheet } from '@/features/threads/custom-snooze-sheet';
import { useApollo } from '@/lib';
import { haptics } from '@/lib/haptics';
import { BriefingCard, CardRow } from '@/features/cloud/card-ui';
import { buildInboxRows, isCardSettled, NO_SETTLED, settleAction, type CollapsibleSectionId, type InboxCard, type SettledCards } from '@/features/cloud/inbox-rows';
import type { CardAction, CardPick } from '../../../cloud/src/contract';

type Props = {
  sessions: readonly InboxSession[];
  connection?: ConnectionState;
  onSessionPress: (session: InboxSession) => void;
  onSettle?: (sessionId: string) => void;
  onReopen?: (sessionId: string) => void;
  onNewSession?: () => void;
  onForked?: (sessionId: string) => void;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Cloud inbox cards; layout lives in buildInboxRows. */
  cards?: readonly InboxCard[];
  onCardPress?: (card: InboxCard) => void;
  onCardAction?: (card: InboxCard, action: CardAction) => void;
  onPick?: (card: InboxCard, pick: CardPick) => void;
  /** Cards settled on this phone. */
  settledCards?: SettledCards;
  /** Runs this phone knows are waiting for approval, to hide their duplicate Hermes cards. */
  pendingRunIds?: ReadonlySet<string>;
  /** False until live sessions and cards have loaded; see `buildInboxRows`. */
  fresh?: boolean;
  onSettleCard?: (card: InboxCard) => void;
  onReopenCard?: (card: InboxCard) => void;
};
const noCards: readonly InboxCard[] = [];
const ignore = () => {};

/** A searchable thread inbox with persistent finish/reopen actions. */
export function SessionList({ sessions, connection = 'connected', onSessionPress, onSettle, onReopen, onNewSession, onForked, refreshing, onRefresh, cards = noCards, onCardPress = ignore, onCardAction = ignore, onPick = ignore, settledCards = NO_SETTLED, pendingRunIds, fresh = true, onSettleCard, onReopenCard }: Props) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const { fontScale } = useWindowDimensions();
  const { bottom } = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<CollapsibleSectionId, boolean>>({ snoozed: true, settled: true });
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Sessions carry their agent; the inbox route only ever shows one agent at a time.
  const { snoozed, snooze, unsnooze } = useSnoozeLedger(sessions[0]?.agentId ?? '');
  const { loaded: autoSettleLoaded, setAutoSettle } = useAutoSettleLedger(sessions[0]?.agentId ?? '');
  const handleFilter = useCallback(() => setAttentionOnly((current) => !current), []);
  const handleCompose = useCallback(() => { Keyboard.dismiss(); onNewSession?.(); }, [onNewSession]);
  const toggle = useCallback((id: CollapsibleSectionId) => setCollapsed((previous) => ({ ...previous, [id]: !previous[id] })), []);
  // Undo acts on the agent it was offered for, so switching agents drops it.
  const toast = useUndoToast(sessions[0]?.agentId ?? '');
  const { show: showUndo } = toast;
  const [customSnooze, setCustomSnooze] = useState<string>();
  // Undo runs after the settle round trip, so it must reach the latest reopen, not the one from swipe time.
  const latestReopen = useRef(onReopen);
  useEffect(() => { latestReopen.current = onReopen; }, [onReopen]);
  // Settle is a connector write without a result here; offer Undo once the thread actually reads as settled.
  const settling = useRef(new Set<string>());
  useEffect(() => {
    for (const session of sessions) {
      if (!session.settled || !settling.current.delete(session.id)) continue;
      const id = session.id;
      showUndo('Settled', () => latestReopen.current?.(id));
    }
  }, [sessions, showUndo]);
  const handleSettle = useCallback((sessionId: string) => {
    if (!onSettle) return;
    settling.current.add(sessionId);
    onSettle(sessionId);
    // A failed settle never reads as settled; stop waiting so a later settle elsewhere cannot show a stale Undo.
    setTimeout(() => settling.current.delete(sessionId), 15_000);
  }, [onSettle]);
  const snoozeUntil = useCallback((sessionId: string, until: number) => {
    const duration = until - Math.floor(Date.now() / 1000);
    // A menu left open past a preset's time would otherwise fall back to the default 24h.
    if (duration <= 0) { Alert.alert('Could not snooze thread', 'That snooze time has passed. Choose another time.'); return; }
    void snooze(sessionId, duration).then((snoozed) => {
      if (snoozed) showUndo('Snoozed', () => { void unsnooze(sessionId); });
    });
  }, [snooze, unsnooze, showUndo]);
  const handleSnooze = useCallback((sessionId: string) => {
    showSnoozeMenu((until) => snoozeUntil(sessionId, until), () => setCustomSnooze(sessionId));
  }, [snoozeUntil]);
  const handleUnsnooze = useCallback((sessionId: string) => { void unsnooze(sessionId); }, [unsnooze]);
  const handleAutoSettle = useCallback((sessionId: string, enabled: boolean) => { void setAutoSettle(sessionId, enabled); }, [setAutoSettle]);
  const rows = useMemo(() => buildInboxRows({ sessions, cards, settledCards, pendingRunIds, runStateLive: connection === 'connected', fresh, query, attentionOnly, collapsed, now, isSnoozed: (id) => isSessionSnoozed(snoozed, id) }), [sessions, cards, settledCards, pendingRunIds, connection, fresh, query, collapsed, attentionOnly, snoozed, now]);

  return <KeyboardFrame key={fontScale} edgeToEdge={HAS_MAIL_TOOLBAR}>
    <View style={styles.container}>
    <LegendList
      style={styles.list}
      data={rows}
      recycleItems
      keyExtractor={(row) => `${row.kind}:${row.id}`}
      getItemType={(row) => row.kind}
      estimatedItemSize={48}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      // Under the native toolbar the list reaches the screen edge, so it clears the home indicator itself.
      contentContainerStyle={HAS_MAIL_TOOLBAR ? [styles.content, { paddingBottom: bottom + MAIL_TOOLBAR_INSET + 20 }] : styles.content}
      refreshing={refreshing}
      onRefresh={onRefresh}
      renderItem={({ item }) => {
        if (item.kind === 'briefing') return <BriefingCard card={item.card} onOpen={onCardPress} onPick={onPick} onAction={onCardAction} onSettle={onSettleCard} />;
        if (item.kind === 'card') return <CardRow card={item.card} settled={item.settled} swipe={item.settled && !isCardSettled(item.card, settledCards) ? undefined : settleAction(item.card, settledCards)} onPress={onCardPress} onAction={onCardAction} onSettle={onSettleCard} onReopen={onReopenCard} />;
        if (item.kind === 'session') return <SessionRow session={item.session} snoozed={isSessionSnoozed(snoozed, item.session.id)} onPress={onSessionPress} onSettle={onSettle ? handleSettle : undefined} onReopen={onReopen} onAutoSettle={autoSettleLoaded ? handleAutoSettle : undefined} onSnooze={handleSnooze} onUnsnooze={handleUnsnooze} onForked={onForked} />;
        if (item.kind === 'caughtUp') return <Text accessibilityRole="header" style={styles.caughtUp}>All caught up</Text>;
        const sectionId = item.id;
        const expanded = Boolean(query.trim()) || !collapsed[sectionId];
        return <Pressable accessibilityRole="button" accessibilityLabel={item.count === undefined ? item.title : `${item.title}, ${item.count}`} accessibilityState={{ expanded }} style={({ pressed }) => [styles.section, pressed && styles.pressed]} onPress={() => toggle(sectionId)}>
          <Text style={styles.sectionText}>{item.count === undefined ? item.title : `${item.title} (${item.count})`}</Text>
          <View style={styles.sectionRule} />
          <SymbolView name={{ ios: expanded ? 'chevron.up' : 'chevron.down', android: expanded ? 'expand_less' : 'expand_more', web: expanded ? 'expand_less' : 'expand_more' }} size={12} tintColor={colors.secondary} />
        </Pressable>;
      }}
      ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyTitle}>{connection !== 'connected' && !sessions.length ? 'Threads are unavailable' : query ? 'No matches' : attentionOnly ? 'All caught up' : 'Start a thread'}</Text><Text style={styles.emptyText}>{connection !== 'connected' && !sessions.length ? 'Reconnect to load your threads.' : query ? 'Try a different search.' : attentionOnly ? 'Nothing needs your attention.' : 'Choose New thread to get started.'}</Text></View>}
    />
    <UndoToast notice={toast.notice} onUndo={toast.undo} />
    </View>
    {customSnooze ? <CustomSnoozeSheet onClose={() => setCustomSnooze(undefined)} onSnooze={(until) => { setCustomSnooze(undefined); snoozeUntil(customSnooze, until); }} /> : null}
    {HAS_MAIL_TOOLBAR ? <MailToolbar attentionOnly={attentionOnly} onFilter={handleFilter} onCompose={handleCompose} onSearch={setQuery} /> : <View style={styles.dock} pointerEvents="box-none">
      <View style={styles.dockCircle}>
        <Pressable accessibilityRole="button" accessibilityLabel={attentionOnly ? 'Show all items' : 'Show items needing attention'} accessibilityState={{ selected: attentionOnly }} onPress={() => setAttentionOnly(!attentionOnly)} style={styles.dockButton}>
          <SymbolView name={{ ios: attentionOnly ? 'line.3.horizontal.decrease.circle.fill' : 'line.3.horizontal.decrease', android: 'filter_list', web: 'filter_list' }} size={24} tintColor={attentionOnly ? colors.cyan : colors.primary} />
        </Pressable>
      </View>
      <View style={styles.search}>
        <SymbolView name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }} size={22} tintColor={colors.primary} />
        <TextInput accessibilityLabel="Search threads" placeholder="Search" placeholderTextColor={colors.secondary} selectionColor={colors.cyan} defaultValue={query} onChangeText={setQuery} style={styles.searchInput} maxFontSizeMultiplier={1.5} autoCorrect={false} clearButtonMode="while-editing" returnKeyType="search" onSubmitEditing={Keyboard.dismiss} />
      </View>
      <View style={styles.dockCircle}>
        <Pressable accessibilityRole="button" accessibilityLabel="New thread" onPress={() => { Keyboard.dismiss(); onNewSession?.(); }} style={styles.dockButton}>
          <SymbolView name={{ ios: 'square.and.pencil', android: 'edit_square', web: 'edit_square' }} size={24} tintColor={colors.primary} />
        </Pressable>
      </View>
    </View>}
  </KeyboardFrame>;
}

const SessionRow = memo(function SessionRow({ session, snoozed, onPress, onSettle, onReopen, onAutoSettle, onSnooze, onUnsnooze, onForked }: {
  session: InboxSession; snoozed: boolean; onPress: Props['onSessionPress']; onSettle: Props['onSettle']; onReopen: Props['onReopen']; onAutoSettle?: (sessionId: string, enabled: boolean) => void; onSnooze: (sessionId: string) => void; onUnsnooze: (sessionId: string) => void; onForked?: Props['onForked'];
}) {
  const styles = useThemedStyles(createStyles);
  const { fontScale } = useWindowDimensions();
  const { factor } = useTextScale();
  const { runtime, deleteSession, setPinned, forkSession, regenerateTitle } = useApollo();
  const largeText = isLargeText(fontScale, factor);
  const swipe = useRef<SwipeableMethods>(null);
  const action = session.settled && onReopen ? { label: 'Reopen', run: () => onReopen(session.id) }
    : snoozed ? { label: 'Unsnooze', run: () => onUnsnooze(session.id) }
    : canSettleSession(session) && onSettle ? { label: 'Settle', run: () => onSettle(session.id) } : undefined;
  // T3 blocks snoozing work that is waiting on you.
  const snoozable = !session.settled && !snoozed && !session.pendingApproval;
  const perform = () => { swipe.current?.close(); action?.run(); };
  const requestSnooze = () => { swipe.current?.close(); onSnooze(session.id); };
  // Opening a snoozed thread returns it to its section.
  const open = () => { Keyboard.dismiss(); if (snoozed) onUnsnooze(session.id); onPress(session); };
  const menu = () => {
    const pinned = runtime[session.agentId]?.sessions.find((candidate) => candidate.id === session.id)?.pinned ?? false;
    const reportFailure = (action: string) => (error: unknown) => {
      Alert.alert(`Could not ${action}`, error instanceof Error ? error.message : 'Try again.');
    };
    showThreadMenu({ title: session.title, pinned, settled: session.settled, snoozed, autoSettle: !session.autoSettleDisabled }, {
      ...(action?.label === 'Settle' ? { onSettle: perform } : {}),
      ...(action?.label === 'Reopen' ? { onReopen: perform } : {}),
      ...(snoozed ? { onUnsnooze: () => onUnsnooze(session.id) } : snoozable ? { onSnooze: () => onSnooze(session.id) } : {}),
      ...(onAutoSettle ? { onAutoSettle: (enabled: boolean) => onAutoSettle(session.id, enabled) } : {}),
      onRegenerateTitle: () => { void regenerateTitle(session.agentId, session.id, session.preview ?? session.title).catch(reportFailure('regenerate the title')); },
      onPin: (next) => { void setPinned(session.agentId, session.id, next).catch(reportFailure(next ? 'pin the thread' : 'unpin the thread')); },
      onFork: () => { void forkSession(session.agentId, session.id).then((id) => onForked?.(id)).catch(reportFailure('fork the thread')); },
      onDelete: () => { void deleteSession(session.agentId, session.id).catch(reportFailure('delete the thread')); },
    });
  };
  const status = session.settled || snoozed ? { text: session.updatedAt, style: styles.date }
    : session.pendingApproval ? { text: 'Needs approval', style: styles.approval }
    : session.running ? { text: 'Working', style: styles.activity }
    : session.queued ? { text: 'Queued', style: styles.activity }
    : session.failed ? { text: 'Failed', style: styles.failed }
    : session.attention ? { text: 'New result', style: styles.activity }
    : { text: session.updatedAt, style: styles.date };
  const quiet = session.settled || snoozed;
  const source = runtime[session.agentId]?.sessions.find((candidate) => candidate.id === session.id)?.source?.trim();
  // Short sources are acronyms (cli); longer ones read as words (discord).
  const sourceLabel = source && source !== 'api_server' ? source.length <= 3 ? source.toUpperCase() : source.charAt(0).toUpperCase() + source.slice(1) : undefined;
  // Hermes previews are the first user message; skip them when the title already says the same thing.
  const preview = session.preview?.trim();
  const showPreview = !quiet && preview && !session.title.startsWith(preview.replace(/…$|\.\.\.$/u, '').slice(0, 40));
  // Swipe left settles (or reopens/unsnoozes), swipe right picks a snooze; a swipe past the threshold commits on release.
  return <Swipeable key={session.id} ref={swipe} overshootLeft={false} overshootRight={false} leftThreshold={SWIPE_COMMIT} rightThreshold={SWIPE_COMMIT} childrenContainerStyle={styles.swipeRow}
    onSwipeableWillOpen={() => haptics.medium()}
    onSwipeableOpen={(direction) => direction === SwipeDirection.LEFT ? perform() : requestSnooze()}
    renderRightActions={action ? () => <Pressable accessibilityRole="button" accessibilityLabel={`${action.label} thread ${session.title}`} onPress={perform} style={styles.swipeAction}><Text style={styles.swipeText}>{action.label}</Text></Pressable> : undefined}
    renderLeftActions={snoozable ? () => <Pressable accessibilityRole="button" accessibilityLabel={`Snooze thread ${session.title}`} onPress={requestSnooze} style={[styles.swipeAction, styles.snoozeAction]}><Text style={styles.swipeText}>Snooze</Text></Pressable> : undefined}>
    <View style={styles.rowContainer}>
    <Pressable
      onPress={open}
      onLongPress={menu}
      accessibilityRole="button"
      accessibilityLabel={`Open thread ${session.title}${session.pendingApproval ? ', needs approval' : session.running ? ', working' : session.queued ? ', queued' : session.failed && !session.settled ? ', failed' : session.settled ? ', finished' : session.attention ? ', new result' : ''}${snoozed ? ', snoozed' : ''}`}
      accessibilityActions={[{ name: 'showActions', label: 'Thread actions' }, ...(action ? [{ name: action.label.toLowerCase(), label: action.label }] : []), ...(snoozable ? [{ name: 'snooze', label: 'Snooze' }] : [])]}
      onAccessibilityAction={(event) => event.nativeEvent.actionName === 'showActions' ? menu() : event.nativeEvent.actionName === 'snooze' ? requestSnooze() : perform()}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.titleLine}>
        <Text numberOfLines={largeText ? undefined : quiet ? 1 : 2} style={[styles.title, quiet && styles.quietTitle, { fontSize: 17 * factor, lineHeight: 23 * factor }]}>{session.title}</Text>
        <Text numberOfLines={1} style={[status.style, { fontSize: 15 * factor, lineHeight: 23 * factor }]}>{status.text}</Text>
      </View>
      {sourceLabel || showPreview ? <Text numberOfLines={1} style={[styles.preview, { fontSize: 15 * factor, lineHeight: 20 * factor }]}>{[sourceLabel, showPreview ? preview : undefined].filter(Boolean).join(' · ')}</Text> : null}
    </Pressable>
    </View>
  </Swipeable>;
});

const SWIPE_ACTION_WIDTH = 84;
// Most of the action's width, so a flick that barely reveals it springs back instead of committing.
const SWIPE_COMMIT = SWIPE_ACTION_WIDTH * 0.7;

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background }, list: { flex: 1 }, content: { paddingBottom: 20 },
  search: { flex: 1, minWidth: 0, height: 44, borderRadius: 8, backgroundColor: colors.surface, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  searchInput: { color: colors.primary, fontSize: 16, flex: 1, height: 44, paddingVertical: 8 },
  section: { marginHorizontal: 12, paddingHorizontal: 8, minHeight: 48, borderRadius: 6, flexDirection: 'row', alignItems: 'center', gap: 12 },
  sectionText: { color: colors.secondary, fontSize: 15 },
  sectionRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  rowContainer: { marginHorizontal: 12, backgroundColor: colors.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  row: { paddingHorizontal: 8, paddingVertical: 12, minHeight: 44, borderRadius: 6, gap: 4, backgroundColor: colors.background, justifyContent: 'center' },
  pressed: { backgroundColor: colors.selectedThread },
  approval: { color: colors.amber }, activity: { color: colors.cyan }, failed: { color: colors.red },
  titleLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 }, title: { color: colors.primary, fontSize: 17, lineHeight: 23, fontWeight: '500', flex: 1, minWidth: 0 },
  date: { color: colors.secondary, fontSize: 15 },
  quietTitle: { color: colors.muted, fontWeight: '400' },
  preview: { color: colors.secondary },
  // Gesture Handler 3 keeps actions behind the row, so the row must paint over them.
  swipeRow: { backgroundColor: colors.background },
  swipeAction: { backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', minWidth: SWIPE_ACTION_WIDTH, paddingHorizontal: 16 }, snoozeAction: { backgroundColor: colors.amber }, swipeText: { color: colors.background, fontWeight: '600', fontSize: 15 },

  dock: { paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  dockCircle: { width: 44, height: 44, borderRadius: 8, backgroundColor: colors.surface },
  dockButton: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  caughtUp: { color: colors.secondary, fontSize: 15, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  empty: { padding: 20, paddingTop: 40, gap: 8 }, emptyTitle: { color: colors.primary, fontSize: 21, fontWeight: '600' }, emptyText: { color: colors.secondary, fontSize: 15, lineHeight: 22 },
});
