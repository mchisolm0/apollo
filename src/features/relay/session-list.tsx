import { memo, useMemo, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { LegendList } from '@legendapp/list/react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

import { relayColors as colors } from './relay-ui';
import { canSettleSession, type InboxSession, type InboxStatus } from './session-inbox';
import type { ConnectionState } from './types';
import { showSessionActions } from './session-actions';

type Props = {
  sessions: readonly InboxSession[];
  connection?: ConnectionState;
  onSessionPress: (session: InboxSession) => void;
  onSettle?: (sessionId: string) => void;
  onReopen?: (sessionId: string) => void;
  onNewSession?: () => void;
  refreshing?: boolean;
  onRefresh?: () => void;
};
type ListRow = { kind: 'section'; id: InboxStatus; title: string; count: number } | { kind: 'session'; id: string; session: InboxSession };
const sections = [{ id: 'attention', title: 'Needs you' }, { id: 'active', title: 'Open' }, { id: 'settled', title: 'Finished' }] as const;


/** A searchable thread inbox with persistent finish/reopen actions. */
export function SessionList({ sessions, connection = 'connected', onSessionPress, onSettle, onReopen, onNewSession, refreshing, onRefresh }: Props) {
  const { fontScale } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [settledVisible, setSettledVisible] = useState(true);
  const settledExpanded = settledVisible || Boolean(query.trim());
  const [attentionOnly, setAttentionOnly] = useState(false);
  const rows = useMemo(() => {
    const result: ListRow[] = [];
    const search = query.trim().toLocaleLowerCase();
    for (const section of sections) {
      if (attentionOnly && section.id !== 'attention') continue;
      const matching = sessions.filter((session) => session.status === section.id && `${session.title} ${session.preview ?? ''}`.toLocaleLowerCase().includes(search));
      if (!matching.length) continue;
      result.push({ kind: 'section', ...section, count: matching.length });
      if (section.id !== 'settled' || settledExpanded) result.push(...matching.map((session): ListRow => ({ kind: 'session', id: session.id, session })));
    }
    return result;
  }, [sessions, query, settledExpanded, attentionOnly]);

  return <KeyboardAvoidingView key={fontScale} style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
        item.id === 'settled' ? <Pressable accessibilityRole="button" accessibilityLabel="Finished threads" accessibilityState={{ expanded: settledExpanded }} style={styles.section} onPress={() => setSettledVisible(!settledVisible)}><Text style={styles.finishedSectionText}>{item.title}</Text><Text style={styles.finishedSectionText}>{item.count} {settledExpanded ? '⌃' : '⌄'}</Text></Pressable>
          : <View style={styles.section}><Text style={styles.sectionText}>{item.title}</Text><Text style={styles.sectionCount}>{item.count}</Text></View>
      ) : <SessionRow session={item.session} onPress={onSessionPress} onSettle={onSettle} onReopen={onReopen} />}
      ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyTitle}>{connection !== 'connected' && !sessions.length ? 'Threads are unavailable' : query ? 'No matching threads' : attentionOnly ? 'All caught up' : 'Start a thread'}</Text><Text style={styles.emptyText}>{connection !== 'connected' && !sessions.length ? 'Reconnect to load your threads.' : query ? 'Try a different search.' : attentionOnly ? 'No threads need your attention.' : 'Choose New thread to get started.'}</Text></View>}
    />

    </View>
  </KeyboardAvoidingView>;
}

const SessionRow = memo(function SessionRow({ session, onPress, onSettle, onReopen }: {
  session: InboxSession; onPress: Props['onSessionPress']; onSettle: Props['onSettle']; onReopen: Props['onReopen'];
}) {
  const { fontScale } = useWindowDimensions();
  const largeText = fontScale > 1.3;
  const swipe = useRef<SwipeableMethods>(null);
  const action = session.settled && onReopen ? { label: 'Reopen', run: () => onReopen(session.id) } : canSettleSession(session) && onSettle ? { label: 'Settle', run: () => onSettle(session.id) } : undefined;
  const perform = () => { swipe.current?.close(); action?.run(); };
  const menu = () => showSessionActions(session.title, [{ label: 'Open thread', onPress: () => onPress(session) }, ...(action ? [{ label: action.label, onPress: perform }] : [])]);
  return <Swipeable key={session.id} ref={swipe} overshootRight={false} renderRightActions={action ? () => <Pressable accessibilityRole="button" accessibilityLabel={`${action.label} thread ${session.title}`} onPress={perform} style={styles.swipeAction}><Text style={styles.swipeText}>{action.label}</Text></Pressable> : undefined}>
    <View style={styles.rowContainer}>
    <Pressable
      onPress={() => { Keyboard.dismiss(); onPress(session); }}
      onLongPress={menu}
      accessibilityRole="button"
      accessibilityLabel={`Open thread ${session.title}${session.pendingApproval ? ', needs approval' : session.running ? ', working' : session.settled ? ', finished' : session.attention ? ', new result' : ''}`}
      accessibilityActions={action ? [{ name: 'showActions', label: 'Thread actions' }, { name: action.label.toLowerCase(), label: action.label }] : [{ name: 'showActions', label: 'Thread actions' }]}
      onAccessibilityAction={(event) => event.nativeEvent.actionName === 'showActions' ? menu() : perform()}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.titleLine}><Text style={styles.hash}>#</Text><Text numberOfLines={largeText ? undefined : 1} style={[styles.title, session.settled && styles.settledTitle]}>{session.title}</Text></View>
      {!session.settled && (session.pendingApproval || session.running || session.attention) ? <Text style={session.pendingApproval ? styles.approval : styles.activity}>{session.pendingApproval ? 'Needs approval' : session.running ? 'Working' : 'New result'}</Text> : null}
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
  rowContainer: { marginHorizontal: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background },
  settleButton: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, justifyContent: 'center', borderRadius: 6 },
  settleText: { color: colors.secondary, fontSize: 13 },
  row: { flex: 1, paddingHorizontal: 8, paddingVertical: 8, minHeight: 44, borderRadius: 6, gap: 6, backgroundColor: colors.background, justifyContent: 'center' },
  pressed: { backgroundColor: '#25262c' },
  approval: { color: colors.amber, fontSize: 13 }, activity: { color: colors.cyan, fontSize: 13 },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: 14 }, title: { color: colors.primary, fontSize: 16, lineHeight: 22, fontWeight: '500', flex: 1 },
  settledTitle: { color: '#808080', fontSize: 14, lineHeight: 20, fontWeight: '400' },
  finishedSectionText: { color: '#929292', fontSize: 14 },
  swipeAction: { backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', minWidth: 84, paddingHorizontal: 16 }, swipeText: { color: colors.background, fontWeight: '600', fontSize: 15 },

  hash: { color: '#94959e', fontSize: 23, lineHeight: 25 },
  dock: { paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  dockCircle: { width: 44, height: 44, borderRadius: 8, backgroundColor: '#17171c' },
  dockButton: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { padding: 20, paddingTop: 40, gap: 8 }, emptyTitle: { color: colors.primary, fontSize: 21, fontWeight: '600' }, emptyText: { color: colors.secondary, fontSize: 15, lineHeight: 22 },
});
