import { useCallback, useMemo, useState } from 'react';
import { HAS_MAIL_TOOLBAR } from '@/features/relay/mail-toolbar';
import { useOutbox } from '@/lib/outbox-context';
import { useIncomingShares } from '@/features/sharing';
import type { InboxSession } from '@/features/relay/session-inbox';
import { Redirect, Stack, useFocusEffect, useRouter } from 'expo-router';
import { ActivityIndicator, Alert, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConnectionAction, useThemedStyles, useColors, type RelayPalette } from '@/features/relay/relay-ui';
import { AgentPicker } from '@/features/relay/agent-picker';
import { SessionList } from '@/features/relay/session-list';
import { useSessionInbox } from '@/features/relay/use-session-inbox';
import { useApollo } from '@/lib';
import { useLaunchGrace } from '@/features/relay/use-launch-grace';
import { countsReady, displayConnection } from '@/features/relay/connection-state';
import { useCloud } from '@/features/cloud/cloud-context';
import { openCardLink, runAction } from '@/features/cloud/card-ui';
import { latestAssistantPreview } from '@/features/cloud/card-text';
import { cardOpenPlan } from '@/features/cloud/inbox-rows';

type Props = {
  agentId?: string;
  /** The open thread, highlighted in the sidebar. */
  selectedId?: string;
  /** Beside the open thread, outside any stack screen, so it draws its own header and dock instead of native bars. */
  sidebar?: boolean;
  onSelectAgent: (agentId: string) => void;
  onOpen: (thread: { id: string; agentId: string }) => void;
};

/** The thread inbox: a stack screen on iPhone, the left pane on wide iPad windows. */
export function InboxPane({ agentId, selectedId, sidebar = false, onSelectAgent, onOpen }: Props) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const outbox = useOutbox();
  const { pendingShares } = useIncomingShares();
  const router = useRouter();
  const { agents, runtime, messages, loading, retryAgent, refreshSessions } = useApollo();
  const agent = agents.find((candidate) => candidate.id === agentId) ?? agents[0];
  const state = agent ? runtime[agent.id] : undefined;
  const inbox = useSessionInbox(agent?.id ?? '', state);
  const cloud = useCloud();
  const refreshCards = cloud.refresh;
  const selectedAgentId = agent?.id;
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    if (!selectedAgentId || refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([refreshSessions(selectedAgentId), refreshCards()]);
    } catch (error) {
      Alert.alert('Could not refresh inbox', error instanceof Error ? error.message : 'Try again.');
    } finally {
      setRefreshing(false);
    }
  }, [selectedAgentId, refreshing, refreshSessions, refreshCards]);
  useFocusEffect(useCallback(() => {
    if (!selectedAgentId) return;
    let polling = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      if (polling || AppState.currentState !== 'active') return;
      polling = true;
      try { await refreshSessions(selectedAgentId); }
      catch { /* The connection controls remain available for a failed background refresh. */ }
      finally { polling = false; }
    };
    const schedule = () => {
      clearInterval(interval);
      if (AppState.currentState === 'active') interval = setInterval(() => void poll(), 30_000);
    };
    schedule();
    void poll();
    const subscription = AppState.addEventListener('change', schedule);
    return () => { clearInterval(interval); subscription.remove(); };
  }, [selectedAgentId, refreshSessions]));
  const newSession = useCallback(() => {
    if (selectedAgentId) onOpen({ id: 'new', agentId: selectedAgentId });
  }, [selectedAgentId, onOpen]);
  const runs = state?.runs;
  const settledLaunch = useLaunchGrace();
  const pendingRunIds = useMemo(() => new Set(Object.values(runs ?? {}).filter((run) => run.status === 'waiting_for_approval').map((run) => run.runId)), [runs]);
  if (loading) return <View style={styles.loading}><ActivityIndicator color={colors.primary} accessibilityLabel="Loading agents" /></View>;
  if (!agent) return <Redirect href="/connect" />;
  const connection = displayConnection(state?.status, settledLaunch);
  // Reconnecting shows only as the picker's dot color. Text appears for states that need action,
  // after the launch grace period, and never changes the header's layout.
  const headerStatus = settledLaunch && (connection === 'offline' || connection === 'revoked') ? connection : undefined;
  const statusAction = headerStatus ? <ConnectionAction state={headerStatus} onReconnect={() => void retryAgent(agent.id)} onDetails={() => router.push({ pathname: '/settings/[agentId]', params: { agentId: agent.id } })} /> : null;
  // Counts and the caught-up row wait for live sessions and cards, so cached numbers never jump.
  const fresh = countsReady({ sessionsLoaded: Boolean(state?.capabilities), cardsLoaded: cloud.fresh, cloudOff: cloud.status === 'off', graceOver: settledLaunch });
  const open = (id: string) => onOpen({ id, agentId: agent.id });
  const pendingSessions = new Map<string, InboxSession>();
  for (const item of outbox.items) {
    if (item.agentId !== agent.id || inbox.sessions.some((session) => session.id === item.sessionId) || pendingSessions.has(item.sessionId)) continue;
    pendingSessions.set(item.sessionId, { id: item.sessionId, agentId: agent.id, title: (item.text || item.attachments[0]?.name || 'Queued thread').slice(0, 72), updatedAt: 'Queued', activityAt: item.createdAt / 1000, sortAt: item.createdAt / 1000, status: 'active', settled: false, attention: false, pendingApproval: false, queued: true, failed: false, pinned: false, autoSettleDisabled: false });
  }
  const queuedIds = new Set(outbox.items.filter((item) => item.agentId === agent.id).map((item) => item.sessionId));
  // Hermes previews the first user message; producer-written threads have none, so use the latest assistant text already loaded.
  const withPreview = (session: InboxSession) => session.preview?.trim() ? session : { ...session, preview: latestAssistantPreview(messages[`${agent.id}:${session.id}`]) ?? session.preview };
  const sessions = [...inbox.sessions.map((session) => withPreview(queuedIds.has(session.id) ? { ...session, queued: true } : session)), ...pendingSessions.values()];
  const hasFeedback = cloud.cards.some((card) => card.source === 'feedback');
  const nativeChrome = HAS_MAIL_TOOLBAR && !sidebar;
  const picker = <AgentPicker agents={agents} selected={agent} runtime={runtime}
    onSelect={onSelectAgent}
    onDetails={(agentId) => router.push({ pathname: '/settings/[agentId]', params: { agentId } })}
    onPair={() => router.push('/connect')} />;
  return <SafeAreaView style={styles.screen} edges={nativeChrome ? [] : ['top']}>
    {nativeChrome ? <Stack.Screen options={{
      headerShown: true,
      headerTitle: () => picker,
      headerStyle: { backgroundColor: colors.background },
      headerTintColor: colors.primary,
      headerShadowVisible: false,
      // Left to right. A native bar button gets the same system glass and 44pt size as the toolbar buttons.
      unstable_headerRightItems: () => [
        ...(statusAction ? [{ type: 'custom' as const, hidesSharedBackground: true, element: statusAction }] : []),
        ...(hasFeedback ? [{ type: 'button', label: 'Feedback', icon: { type: 'sfSymbol', name: 'bubble.left.and.text.bubble.right' }, tintColor: colors.primary, onPress: () => router.push('/feedback') }] as const : []),
        { type: 'button', label: 'Settings', icon: { type: 'sfSymbol', name: 'gearshape' }, tintColor: colors.primary, onPress: () => router.push('/settings') },
      ],
    }} /> : <View style={styles.header}>
      <View style={styles.identity}>{picker}</View>
      <View style={styles.statusSlot}>{statusAction}</View>
      {hasFeedback ? <Pressable accessibilityRole="button" accessibilityLabel="Feedback" onPress={() => router.push('/feedback')} style={({ pressed }) => [styles.dockButton, pressed && { opacity: 0.6 }]}>
        <SymbolView name={{ ios: 'bubble.left.and.text.bubble.right', android: 'forum', web: 'forum' }} size={22} tintColor={colors.primary} />
      </Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push('/settings')} style={({ pressed }) => [styles.dockButton, pressed && { opacity: 0.6 }]}>
        <SymbolView name={{ ios: 'gearshape', android: 'settings', web: 'settings' }} size={22} tintColor={colors.primary} />
      </Pressable>
    </View>}
    {pendingShares.length > 0 ? <Pressable accessibilityRole="button" onPress={() => router.push("/share")} style={{ minHeight: 44, paddingHorizontal: 20, justifyContent: "center" }}><Text style={{ color: colors.cyan }}>Open shared content ({pendingShares.length})</Text></Pressable> : null}
    {inbox.error ? <Text style={styles.error} accessibilityRole="alert">{inbox.error}</Text> : null}
    {cloud.error ? <Text style={styles.error} accessibilityRole="alert" onPress={cloud.dismissError}>{cloud.error}</Text> : null}
    <SessionList nativeToolbar={nativeChrome} selectedId={selectedId} connection={connection} sessions={sessions} onSessionPress={(session) => open(session.id)} onSettle={(id) => { void inbox.settle(id); }} onReopen={(id) => { void inbox.reopen(id); }} onNewSession={newSession} onForked={(id) => open(id)}
      refreshing={refreshing}
      onRefresh={() => { void refresh(); }}
      cards={cloud.cards}
      onCardPress={(card) => {
        const plan = cardOpenPlan(card);
        // A link only counts as opened once the system took it; the detail screen settles on its own.
        if (plan.target === 'link' && card.url) void openCardLink(card.url).then((opened) => { if (opened && plan.settle) cloud.settle(card.id); });
        else router.push({ pathname: '/card/[id]', params: { id: card.id } });
      }}
      onCardAction={(card, action) => runAction(card, action, (cardId, actionId) => { void cloud.respond(cardId, { actionId }); }, () => { if (cardOpenPlan(card).settle) cloud.settle(card.id); })}
      onPick={(card, pick) => { void cloud.respond(card.id, { pick: pick.n, done: !pick.done }); }}
      settledCards={cloud.settled}
      fresh={fresh}
      pendingRunIds={pendingRunIds}
      onSettleCard={(card) => cloud.settle(card.id)}
      onReopenCard={(card) => cloud.reopen(card.id)} />
  </SafeAreaView>;
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 52, paddingHorizontal: 12 },
  identity: { flex: 1, minWidth: 0 },
  // Fixed width so a status appearing never moves the picker or the gear.
  statusSlot: { width: 112, alignItems: 'flex-end' },
  // Same size and fill as the bottom dock's buttons.
  dockButton: { width: 44, height: 44, borderRadius: 8, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  error: { color: colors.red, fontSize: 14, padding: 20 },
});
