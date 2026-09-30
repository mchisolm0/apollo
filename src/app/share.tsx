import { useFocusEffect, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useCallback, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useColors } from '@/features/relay/relay-ui';
import { useEkho } from '@/lib';
import { useIncomingShares } from '@/features/sharing';

export default function ShareRoute() {
  const router = useRouter();
  const colors = useColors();
  const { agents, runtime } = useEkho();
  const { pendingShares, error, refresh, discardShare } = useIncomingShares();
  const [selectedShareId, setSelectedShareId] = useState<string>();
  const share = pendingShares.find((candidate) => candidate.id === selectedShareId) ?? pendingShares[0];
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const agent = agents.find((candidate) => candidate.id === selectedAgentId) ?? agents[0];
  const sessions = agent ? runtime[agent.id]?.sessions ?? [] : [];
  const open = (id: string) => { if (agent && share) router.replace({ pathname: '/(sessions)/session/[id]', params: { agentId: agent.id, id, shareId: share.id } }); };
  useFocusEffect(useCallback(() => { void refresh().catch(() => {}); }, [refresh]));
  const discard = () => { if (share) void discardShare(share.id).catch(() => {}); };
  return <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
    <View style={[styles.header, { borderBottomColor: colors.line }]}><Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()}><Text style={[styles.back, { color: colors.primary }]}>‹</Text></Pressable><Text style={[styles.title, { color: colors.primary }]}>Share to Ekho</Text><View style={styles.spacer} /></View>
    <ScrollView contentContainerStyle={styles.content}>
      {error ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.red }]}>{error}</Text> : null}
      {!pendingShares.length ? <Text style={[styles.empty, { color: colors.secondary }]}>No pending share.</Text> : <>
        {pendingShares.length > 1 ? <View><Text style={[styles.section, { color: colors.muted }]}>Pending shares</Text>{pendingShares.map((candidate) => <Pressable key={candidate.id} accessibilityRole="radio" accessibilityState={{ selected: candidate.id === share?.id }} onPress={() => setSelectedShareId(candidate.id)} style={[styles.row, { borderBottomColor: colors.line }]}><Text style={[styles.label, { color: colors.primary }]} numberOfLines={1}>{candidate.text || `${candidate.attachments.length} attachment${candidate.attachments.length === 1 ? '' : 's'}`}</Text><Text style={[styles.value, { color: candidate.id === share?.id ? colors.cyan : colors.secondary }]}>{candidate.id === share?.id ? 'Selected' : 'Choose'}</Text></Pressable>)}</View> : null}
        <Text style={[styles.preview, { color: colors.primary }]} numberOfLines={5}>{share.text || `${share.attachments.length} attachment${share.attachments.length === 1 ? '' : 's'}`}</Text>
        <Text style={[styles.section, { color: colors.muted }]}>Agent</Text>
        {agents.map((candidate) => <Pressable key={candidate.id} accessibilityRole="radio" accessibilityState={{ selected: candidate.id === agent?.id }} onPress={() => setSelectedAgentId(candidate.id)} style={[styles.row, { borderBottomColor: colors.line }]}><Text style={[styles.label, { color: colors.primary }]}>{candidate.label}</Text><Text style={[styles.value, { color: candidate.id === agent?.id ? colors.cyan : colors.secondary }]}>{candidate.id === agent?.id ? 'Selected' : 'Choose'}</Text></Pressable>)}
        {!agents.length ? <Text style={[styles.empty, { color: colors.secondary }]}>Pair an agent before opening a share.</Text> : null}
        <Text style={[styles.section, { color: colors.muted }]}>Open in</Text>
        <Pressable accessibilityRole="button" onPress={() => open('new')} style={[styles.row, { borderBottomColor: colors.line }]}><Text style={[styles.label, { color: colors.primary }]}>New thread</Text><Text style={[styles.value, { color: colors.cyan }]}>Open</Text></Pressable>
        {sessions.map((session) => <Pressable key={session.id} accessibilityRole="button" onPress={() => open(session.id)} style={[styles.row, { borderBottomColor: colors.line }]}><Text style={[styles.label, { color: colors.primary }]} numberOfLines={1}>{session.title || 'Untitled thread'}</Text><Text style={[styles.value, { color: colors.cyan }]}>Open</Text></Pressable>)}
        <Pressable accessibilityRole="button" accessibilityLabel="Discard selected share" onPress={discard} style={styles.discard}><Text style={[styles.value, { color: colors.red }]}>Discard share</Text></Pressable>
      </>}
      {error ? <Pressable accessibilityRole="button" onPress={() => void refresh().catch(() => {})} style={styles.retry}><Text style={[styles.value, { color: colors.cyan }]}>Retry import</Text></Pressable> : null}
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({ safe: { flex: 1 }, header: { minHeight: 58, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, back: { fontSize: 34, fontWeight: '300' }, title: { fontSize: 17, fontWeight: '600' }, spacer: { width: 24 }, content: { padding: 16 }, preview: { fontSize: 16, lineHeight: 23, paddingVertical: 10 }, section: { fontSize: 12, letterSpacing: 0.6, paddingTop: 24, paddingBottom: 8 }, row: { minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, label: { flex: 1, fontSize: 15 }, value: { fontSize: 13 }, error: { fontSize: 13, paddingVertical: 10 }, empty: { paddingVertical: 20, fontSize: 15 }, retry: { minHeight: 44, justifyContent: 'center' }, discard: { minHeight: 52, justifyContent: 'center', alignItems: 'flex-end' } });
