import { LegendList } from '@legendapp/list/react-native';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { IconButton, useTextScale, useThemedStyles, type RelayPalette } from '@/features/relay/relay-ui';

import { CardRow, runAction } from './card-ui';
import { useCloud } from './cloud-context';
import { FEEDBACK_FILTERS, feedbackRows, type FeedbackFilter } from './feedback-rows';
import { isCardSettled, settleAction } from './inbox-rows';

/** Every feedback report in one list, filtered by who's waiting or by bug and idea. */
export function FeedbackScreen({ onBack }: { onBack: () => void }) {
  const styles = useThemedStyles(createStyles);
  const { factor } = useTextScale();
  const cloud = useCloud();
  const [filter, setFilter] = useState<FeedbackFilter>('waiting');
  const rows = useMemo(() => feedbackRows(cloud.cards, filter), [cloud.cards, filter]);
  return <View style={styles.screen}>
    <View style={styles.header}>
      <IconButton name="chevron.left" label="Go back" onPress={onBack} />
      <Text style={[styles.title, { fontSize: 17 * factor }]} accessibilityRole="header">Feedback</Text>
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters} contentContainerStyle={styles.filterRow} accessibilityRole="tablist">
      {(Object.keys(FEEDBACK_FILTERS) as FeedbackFilter[]).map((id) => {
        const count = feedbackRows(cloud.cards, id).length;
        const selected = id === filter;
        return <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={`${FEEDBACK_FILTERS[id]}, ${count}`} onPress={() => setFilter(id)} style={({ pressed }) => [styles.filter, pressed && { opacity: 0.6 }]}>
          <Text style={[styles.filterText, selected && styles.filterSelected, { fontSize: 15 * factor }]}>{FEEDBACK_FILTERS[id]} <Text style={styles.count}>{count}</Text></Text>
        </Pressable>;
      })}
    </ScrollView>
    <LegendList
      data={rows}
      recycleItems
      keyExtractor={(card) => card.id}
      estimatedItemSize={64}
      renderItem={({ item }) => <CardRow
        card={item}
        settled={isCardSettled(item, cloud.settled)}
        swipe={settleAction(item, cloud.settled)}
        onPress={(card) => router.push({ pathname: '/card/[id]', params: { id: card.id } })}
        onAction={(card, action) => runAction(card, action, (cardId, actionId) => { void cloud.respond(cardId, { actionId }); })}
        onSettle={(card) => cloud.settle(card.id)}
        onReopen={(card) => cloud.reopen(card.id)} />}
      ListEmptyComponent={<Text style={[styles.empty, { fontSize: 15 * factor }]}>{cloud.status !== 'off' && !cloud.ready ? 'Loading feedback' : filter === 'waiting' ? 'Nobody is waiting on a reply.' : 'No feedback here yet.'}</Text>}
    />
  </View>;
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 56, paddingLeft: 6, paddingRight: 16 },
  title: { color: colors.primary, fontWeight: '600' },
  filters: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  filterRow: { gap: 18, paddingHorizontal: 20 },
  filter: { minHeight: 40, justifyContent: 'center' },
  filterText: { color: colors.muted, fontWeight: '500' },
  filterSelected: { color: colors.primary, fontWeight: '700' },
  count: { color: colors.muted, fontVariant: ['tabular-nums'] },
  empty: { color: colors.secondary, padding: 20 },
});
