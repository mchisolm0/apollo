import { memo, useMemo, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
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

const glassAvailable = isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
const DockSurface = glassAvailable ? GlassView : View;

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
    <View style={styles.heading}><Text accessibilityRole="header" style={styles.headingText}>Threads</Text></View>
    <View style={styles.container}>
    <LegendList
      style={styles.list}
      data={rows}
      recycleItems
      keyExtractor={(row) => `${row.kind}:${row.id}`}
      getItemType={(row) => row.kind}
      estimatedItemSize={66}
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
    <View style={styles.dock} pointerEvents="box-none">
      <DockSurface colorScheme="dark" isInteractive style={[styles.dockCircle, !glassAvailable && styles.dockFallback]}>
        <Pressable accessibilityRole="button" accessibilityLabel={attentionOnly ? 'Show all threads' : 'Show threads needing attention'} accessibilityState={{ selected: attentionOnly }} onPress={() => setAttentionOnly(!attentionOnly)} style={styles.dockButton}>
          <SymbolView name={{ ios: attentionOnly ? 'line.3.horizontal.decrease.circle.fill' : 'line.3.horizontal.decrease', android: 'filter_list', web: 'filter_list' }} size={24} tintColor={attentionOnly ? colors.cyan : colors.primary} />
        </Pressable>
      </DockSurface>
      <DockSurface colorScheme="dark" style={[styles.search, !glassAvailable && styles.dockFallback]}>
        <SymbolView name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }} size={22} tintColor={colors.primary} />
        <TextInput accessibilityLabel="Search threads" placeholder="Search" placeholderTextColor={colors.secondary} selectionColor={colors.cyan} value={query} onChangeText={setQuery} style={styles.searchInput} maxFontSizeMultiplier={1.5} autoCorrect={false} clearButtonMode="while-editing" returnKeyType="search" onSubmitEditing={Keyboard.dismiss} />
      </DockSurface>
      <DockSurface colorScheme="dark" isInteractive style={[styles.dockCircle, !glassAvailable && styles.dockFallback]}>
        <Pressable accessibilityRole="button" accessibilityLabel="New thread" onPress={() => { Keyboard.dismiss(); onNewSession?.(); }} style={styles.dockButton}>
          <SymbolView name={{ ios: 'square.and.pencil', android: 'edit_square', web: 'edit_square' }} size={24} tintColor={colors.primary} />
        </Pressable>
      </DockSurface>
    </View>
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
    <View style={[styles.row, session.settled && styles.settledRow]}>
    <Pressable
      onPress={() => { Keyboard.dismiss(); onPress(session); }}
      onLongPress={menu}
      accessibilityRole="button"
      accessibilityLabel={`Open thread ${session.title}${session.pendingApproval ? ', needs approval' : session.running ? ', working' : session.settled ? ', finished' : session.attention ? ', new result' : ''}`}
      accessibilityActions={action ? [{ name: 'showActions', label: 'Thread actions' }, { name: action.label.toLowerCase(), label: action.label }] : [{ name: 'showActions', label: 'Thread actions' }]}
      onAccessibilityAction={(event) => event.nativeEvent.actionName === 'showActions' ? menu() : perform()}
      style={({ pressed }) => [styles.rowContent, pressed && styles.pressed]}
    >
      <View style={[styles.titleLine, largeText && styles.titleLineLarge]}><Text numberOfLines={largeText ? undefined : session.settled ? 1 : 2} style={[styles.title, largeText && styles.titleLarge, session.settled && styles.settledTitle]}>{session.title}</Text><Text style={[styles.metaText, session.settled && styles.settledMeta]}>{session.updatedAt}</Text></View>
      {!session.settled && (session.pendingApproval || session.running || session.attention) ? <Text style={session.pendingApproval ? styles.approval : styles.activity}>{session.pendingApproval ? 'Needs approval' : session.running ? 'Working' : 'New result'}</Text> : null}
      {!session.settled && session.preview ? <Text numberOfLines={1} style={styles.preview}>{session.preview}</Text> : null}
    </Pressable>
    {action?.label === 'Settle' ? <Pressable accessibilityRole="button" accessibilityLabel={`Settle thread ${session.title}`} onPress={perform} style={styles.settleButton}><Text style={styles.settleText}>Settle</Text></Pressable> : null}
    </View>
  </Swipeable>;
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background }, list: { flex: 1 }, content: { paddingBottom: 92 },
  heading: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 },
  headingText: { color: colors.primary, fontSize: 32, lineHeight: 38, fontWeight: '700', letterSpacing: -1, marginBottom: 14 },
  search: { flex: 1, minWidth: 0, height: 56, borderRadius: 28, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10 },
  searchInput: { color: colors.primary, fontSize: 19, flex: 1, height: 56, paddingVertical: 8 },
  section: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 6, minHeight: 44, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionText: { color: colors.primary, fontSize: 14, fontWeight: '600' }, sectionCount: { color: colors.secondary, fontSize: 13 },
  row: { marginHorizontal: 20, paddingVertical: 14, minHeight: 60, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, backgroundColor: colors.background, flexDirection: 'row', alignItems: 'center' },
  rowContent: { flex: 1, gap: 6 },
  pressed: { opacity: 0.65 },
  metaText: { color: colors.secondary, fontSize: 12 }, approval: { color: colors.amber, fontSize: 13 }, activity: { color: colors.cyan, fontSize: 13 },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: 14 }, title: { color: colors.primary, fontSize: 17, lineHeight: 23, fontWeight: '600', flex: 1 },
  titleLineLarge: { flexDirection: 'column', alignItems: 'flex-start', gap: 4 }, titleLarge: { flex: 0 },
  preview: { color: colors.secondary, fontSize: 14, lineHeight: 20 }, settledRow: { paddingVertical: 13, minHeight: 48, borderBottomColor: '#181818' },
  settledTitle: { color: '#808080', fontSize: 14, lineHeight: 20, fontWeight: '400' }, settledMeta: { color: '#737373' },
  finishedSectionText: { color: '#929292', fontSize: 14 },
  swipeAction: { backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', minWidth: 84, paddingHorizontal: 16 }, swipeText: { color: colors.background, fontWeight: '600', fontSize: 15 },
  settleButton: { paddingLeft: 12, paddingVertical: 8 }, settleText: { color: colors.secondary, fontSize: 13 },
  dock: { position: 'absolute', bottom: 8, left: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 10 },
  dockCircle: { width: 56, height: 56, borderRadius: 28 },
  dockButton: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dockFallback: { backgroundColor: '#242424', borderWidth: StyleSheet.hairlineWidth, borderColor: '#484848' },
  empty: { padding: 20, paddingTop: 40, gap: 8 }, emptyTitle: { color: colors.primary, fontSize: 21, fontWeight: '600' }, emptyText: { color: colors.secondary, fontSize: 15, lineHeight: 22 },
});
