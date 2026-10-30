import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useRecyclingState } from '@legendapp/list/react-native';

import { MessageContent } from './message-content';
import { useColors, useThemedStyles, type RelayPalette } from './relay-ui';
import type { CronDelivery } from './transcript';

// A cron mirror folds to one quiet line naming its job; tapping shows the delivered text.
export const CronDeliveryEntry = memo(function CronDeliveryEntry({ delivery, onDisclosure }: { delivery: CronDelivery; onDisclosure: () => void }) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const [expanded, setExpanded] = useRecyclingState(false);
  const expandable = Boolean(delivery.text);
  return <View style={styles.cron}>
    <Pressable
      style={styles.toggle}
      disabled={!expandable}
      accessibilityRole={expandable ? 'button' : 'text'}
      accessibilityLabel={`Cron delivery, ${delivery.job}`}
      accessibilityState={expandable ? { expanded } : undefined}
      onPress={() => { onDisclosure(); setExpanded(!expanded); }}
    >
      <SymbolView name={{ ios: 'clock', android: 'schedule', web: 'schedule' }} size={12} tintColor={colors.muted} />
      <Text style={styles.label} numberOfLines={1}>{delivery.job}</Text>
      {expandable ? <SymbolView name={{ ios: expanded ? 'chevron.up' : 'chevron.down', android: expanded ? 'expand_less' : 'expand_more', web: expanded ? 'expand_less' : 'expand_more' }} size={10} tintColor={colors.secondary} /> : null}
    </Pressable>
    {expanded ? <View style={styles.body}><MessageContent text={delivery.text} /></View> : null}
  </View>;
});

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  cron: { marginBottom: 12 },
  toggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { flexShrink: 1, color: colors.secondary, fontSize: 13 },
  body: { paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: colors.lineStrong },
});
