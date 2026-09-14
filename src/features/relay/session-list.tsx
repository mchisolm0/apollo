import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { LegendList } from '@legendapp/list/react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

import { relayColors as colors, useTextScale } from './relay-ui';
import { KeyboardFrame } from './keyboard-frame';
import { canSettleSession, isSessionSnoozed, type InboxSession, type InboxStatus } from './session-inbox';
import { useSnoozeLedger } from './use-session-inbox';
import type { ConnectionState } from './types';
import { showThreadMenu } from './session-actions';
import { useEkho } from '@/lib';

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
};
type SectionId = InboxStatus | 'snoozed';
type ListRow = { kind: 'section'; id: SectionId; title: string; count: number } | { kind: 'session'; id: string; session: InboxSession };
const sections = [
  { id: 'attention', title: 'Needs you', collapsed: false },
  { id: 'active', title: 'Open', collapsed: false },
  { id: 'snoozed', title: 'Snoozed', collapsed: true },
  { id: 'settled', title: 'Settled', collapsed: true },
] as const satisfies readonly { id: SectionId; title: string; collapsed: boolean }[];


/** A searchable thread inbox with persistent finish/reopen actions. */
export function SessionList({ sessions, connection = 'connected', onSessionPress, onSettle, onReopen, onNewSession, onForked, refreshing, onRefresh }: Props) {
  const { fontScale } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<SectionId, boolean>>({ attention: false, active: false, snoozed: true, settled: true });
  const [attentionOnly, setAttentionOnly] = useState(false);
  // Sessions carry their agent; the inbox route only ever shows one agent at a time.
  const { snoozed, snooze, unsnooze } = useSnoozeLedger(sessions[0]?.agentId ?? '');
  const toggle = useCallback((id: SectionId) => setCollapsed((previous) => ({ ...previous, [id]: !previous[id] })), []);
  const handleSnooze = useCallback((sessionId: string) => { void snooze(sessionId); }, [snooze]);
  const handleUnsnooze = useCallback((sessionId: string) => { void unsnooze(sessionId); }, [unsnooze]);
  const rows = useMemo(() => {
    const result: ListRow[] = [];
    const search = query.trim().toLocaleLowerCase();
    const searching = Boolean(search);
    for (const section of sections) {
      if (attentionOnly && section.id !== 'attention') continue;
      const matching = sessions.filter((session) => {
        const bucket: SectionId = session.settled ? 'settled' : isSessionSnoozed(snoozed, session.id) ? 'snoozed' : session.status;
        return bucket === section.id && `${session.title} ${session.preview ?? ''}`.toLocaleLowerCase().includes(search);
      });
      if (!matching.length) continue;
      result.push({ kind: 'section', ...section, count: matching.length });
      if (searching || !collapsed[section.id]) result.push(...matching.map((session): ListRow => ({ kind: 'session', id: session.id, session })));
    }
    return result;
  }, [sessions, query, collapsed, attentionOnly, snoozed]);

  return <KeyboardFrame key={fontScale}>
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
      contentContainerStyle={styles.content}
      refreshing={refreshing}
      onRefresh={onRefresh}
      renderItem={({ item }) => item.kind === 'section' ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}, ${item.count} threads`} accessibilityState={{ expanded: Boolean(query.trim()) || !collapsed[item.id] }} style={styles.section} onPress={() => toggle(item.id)}>
          <Text style={item.id === 'settled' ? styles.finishedSectionText : styles.sectionText}>{item.title}</Text>
          <Text style={item.id === 'settled' ? styles.finishedSectionText : styles.sectionCount}>{item.count} {Boolean(query.trim()) || !collapsed[item.id] ? '⌃' : '⌄'}</Text>
        </Pressable>
      ) : <SessionRow session={item.session} snoozed={isSessionSnoozed(snoozed, item.session.id)} onPress={onSessionPress} onSettle={onSettle} onReopen={onReopen} onSnooze={handleSnooze} onUnsnooze={handleUnsnooze} onForked={onForked} />}
      ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyTitle}>{connection !== 'connected' && !sessions.length ? 'Threads are unavailable' : query ? 'No matching threads' : attentionOnly ? 'All caught up' : 'Start a thread'}</Text><Text style={styles.emptyText}>{connection !== 'connected' && !sessions.length ? 'Reconnect to load your threads.' : query ? 'Try a different search.' : attentionOnly ? 'No threads need your attention.' : 'Choose New thread to get started.'}</Text></View>}
    />
    </View>
    <View style={styles.dock} pointerEvents="box-none">
      <View style={styles.dockCircle}>
        <Pressable accessibilityRole="button" accessibilityLabel={attentionOnly ? 'Show all threads' : 'Show threads needing attention'} accessibilityState={{ selected: attentionOnly }} onPress={() => setAttentionOnly(!attentionOnly)} style={styles.dockButton}>
          <SymbolView name={{ ios: attentionOnly ? 'line.3.horizontal.decrease.circle.fill' : 'line.3.horizontal.decrease', android: 'filter_list', web: 'filter_list' }} size={24} tintColor={attentionOnly ? colors.cyan : colors.primary} />
        </Pressable>
      </View>
      <View style={styles.search}>
        <SymbolView name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }} size={22} tintColor={colors.primary} />
        <TextInput accessibilityLabel="Search threads" placeholder="Search" placeholderTextColor={colors.secondary} selectionColor={colors.cyan} value={query} onChangeText={setQuery} style={styles.searchInput} maxFontSizeMultiplier={1.5} autoCorrect={false} clearButtonMode="while-editing" returnKeyType="search" onSubmitEditing={Keyboard.dismiss} />
      </View>
      <View style={styles.dockCircle}>
        <Pressable accessibilityRole="button" accessibilityLabel="New thread" onPress={() => { Keyboard.dismiss(); onNewSession?.(); }} style={styles.dockButton}>
          <SymbolView name={{ ios: 'square.and.pencil', android: 'edit_square', web: 'edit_square' }} size={24} tintColor={colors.primary} />
        </Pressable>
      </View>
    </View>
  </KeyboardFrame>;
}

const SessionRow = memo(function SessionRow({ session, snoozed, onPress, onSettle, onReopen, onSnooze, onUnsnooze, onForked }: {
  session: InboxSession; snoozed: boolean; onPress: Props['onSessionPress']; onSettle: Props['onSettle']; onReopen: Props['onReopen']; onSnooze: (sessionId: string) => void; onUnsnooze: (sessionId: string) => void; onForked?: Props['onForked'];
}) {
  const { fontScale } = useWindowDimensions();
  const { factor } = useTextScale();
  const { runtime, deleteSession, setPinned, forkSession, regenerateTitle } = useEkho();
  const largeText = fontScale > 1.3;
  const swipe = useRef<SwipeableMethods>(null);
  const action = session.settled && onReopen ? { label: 'Reopen', run: () => onReopen(session.id) }
    : snoozed ? { label: 'Unsnooze', run: () => onUnsnooze(session.id) }
    : canSettleSession(session) && onSettle ? { label: 'Settle', run: () => onSettle(session.id) } : undefined;
  const perform = () => { swipe.current?.close(); action?.run(); };
  // Opening a snoozed thread returns it to its section.
  const open = () => { Keyboard.dismiss(); if (snoozed) onUnsnooze(session.id); onPress(session); };
  const menu = () => {
    const pinned = runtime[session.agentId]?.sessions.find((candidate) => candidate.id === session.id)?.pinned ?? false;
    showThreadMenu({ title: session.title, pinned, settled: session.settled, snoozed }, {
      onOpen: open,
      ...(action?.label === 'Settle' ? { onSettle: perform } : {}),
      ...(action?.label === 'Reopen' ? { onReopen: perform } : {}),
      ...(snoozed ? { onUnsnooze: () => onUnsnooze(session.id) } : { onSnooze: () => onSnooze(session.id) }),
      onRegenerateTitle: () => { void regenerateTitle(session.agentId, session.id, session.preview ?? session.title); },
      onPin: (next) => { void setPinned(session.agentId, session.id, next); },
      onFork: () => { void forkSession(session.agentId, session.id).then((id) => onForked?.(id)); },
      onDelete: () => { void deleteSession(session.agentId, session.id); },
    });
  };
  const status = session.settled ? { text: session.updatedAt, style: styles.date }
    : session.pendingApproval ? { text: 'Needs approval', style: styles.approval }
    : session.running ? { text: 'Working', style: styles.activity }
    : session.failed ? { text: 'Failed', style: styles.failed }
    : session.attention ? { text: 'New result', style: styles.activity }
    : { text: session.updatedAt, style: styles.date };
  const statusScaled = status.style === styles.date
    ? { fontSize: 12 * factor, lineHeight: 20 * factor }
    : { fontSize: 13 * factor };
  return <Swipeable key={session.id} ref={swipe} overshootRight={false} renderRightActions={action ? () => <Pressable accessibilityRole="button" accessibilityLabel={`${action.label} thread ${session.title}`} onPress={perform} style={styles.swipeAction}><Text style={styles.swipeText}>{action.label}</Text></Pressable> : undefined}>
    <View style={styles.rowContainer}>
    <Pressable
      onPress={open}
      onLongPress={menu}
      accessibilityRole="button"
      accessibilityLabel={`Open thread ${session.title}${session.pendingApproval ? ', needs approval' : session.running ? ', working' : session.failed && !session.settled ? ', failed' : session.settled ? ', finished' : session.attention ? ', new result' : ''}${snoozed ? ', snoozed' : ''}`}
      accessibilityActions={action ? [{ name: 'showActions', label: 'Thread actions' }, { name: action.label.toLowerCase(), label: action.label }] : [{ name: 'showActions', label: 'Thread actions' }]}
      onAccessibilityAction={(event) => event.nativeEvent.actionName === 'showActions' ? menu() : perform()}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.titleLine}><Text style={[styles.hash, { fontSize: 23 * factor, lineHeight: 25 * factor }]}>#</Text><Text numberOfLines={largeText ? undefined : 1} style={[styles.title, session.settled && styles.settledTitle, { fontSize: (session.settled ? 14 : 17) * factor, lineHeight: (session.settled ? 20 : 23) * factor }]}>{session.title}</Text><Text numberOfLines={1} style={[status.style, statusScaled]}>{status.text}</Text></View>
    </Pressable>
    {action?.label === 'Settle' ? <Pressable accessibilityRole="button" accessibilityLabel={`Settle thread ${session.title}`} onPress={perform} style={({ pressed }) => [styles.settleButton, pressed && styles.pressed]}><Text style={styles.settleText}>Settle</Text></Pressable> : null}
    </View>
  </Swipeable>;
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background }, list: { flex: 1 }, content: { paddingBottom: 20 },
  search: { flex: 1, minWidth: 0, height: 44, borderRadius: 8, backgroundColor: '#17171c', paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  searchInput: { color: colors.primary, fontSize: 16, flex: 1, height: 44, paddingVertical: 8 },
  section: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 6, minHeight: 44, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionText: { color: colors.primary, fontSize: 14, fontWeight: '600' }, sectionCount: { color: colors.secondary, fontSize: 13 },
  rowContainer: { marginHorizontal: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#303036' },
  settleButton: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, justifyContent: 'center', borderRadius: 6 },
  settleText: { color: colors.secondary, fontSize: 13 },
  row: { flex: 1, paddingHorizontal: 8, paddingVertical: 8, minHeight: 44, borderRadius: 6, gap: 6, backgroundColor: colors.background, justifyContent: 'center' },
  pressed: { backgroundColor: '#25262c' },
  approval: { color: colors.amber, fontSize: 13 }, activity: { color: colors.cyan, fontSize: 13 }, failed: { color: colors.red, fontSize: 13 },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 }, title: { color: colors.primary, fontSize: 17, lineHeight: 23, fontWeight: '500', flex: 1, minWidth: 0 },
  date: { color: colors.secondary, fontSize: 12, lineHeight: 20 },
  settledTitle: { color: '#808080', fontSize: 14, lineHeight: 20, fontWeight: '400' },
  finishedSectionText: { color: '#929292', fontSize: 14 },
  swipeAction: { backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', minWidth: 84, paddingHorizontal: 16 }, swipeText: { color: colors.background, fontWeight: '600', fontSize: 15 },

  hash: { color: '#94959e', fontSize: 23, lineHeight: 25 },
  dock: { paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  dockCircle: { width: 44, height: 44, borderRadius: 8, backgroundColor: '#17171c' },
  dockButton: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { padding: 20, paddingTop: 40, gap: 8 }, emptyTitle: { color: colors.primary, fontSize: 21, fontWeight: '600' }, emptyText: { color: colors.secondary, fontSize: 15, lineHeight: 22 },
});
