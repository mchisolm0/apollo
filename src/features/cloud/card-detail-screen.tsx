import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { MessageContent } from '@/features/relay/message-content';
import { RelayButton, RelayHeader, useColors, useRelayStyles, useTextScale, useThemedStyles, type RelayPalette } from '@/features/relay/relay-ui';

import type { CardPick } from '../../../cloud/src/contract';
import { actionLabel, cardActions, cardAge, CardPicks, openCardLink, runAction, sourceLabels } from './card-ui';
import { useCloud } from './cloud-context';

/** Full card: long bodies (digests, job matches), meta, picks and every action. */
export function CardDetailScreen({ cardId, onBack }: { cardId: string; onBack: () => void }) {
  const styles = useThemedStyles(createStyles);
  const uiStyles = useRelayStyles();
  const colors = useColors();
  const { factor } = useTextScale();
  const cloud = useCloud();
  const card = cloud.cards.find((candidate) => candidate.id === cardId);
  if (!card) {
    const waiting = cloud.status !== 'off' && !cloud.ready;
    return <View style={uiStyles.screen}>
      <RelayHeader title="Card" onBack={onBack} />
      <View style={styles.empty}>
        {waiting ? <ActivityIndicator color={colors.secondary} accessibilityLabel="Loading card" /> : <Text style={styles.emptyText}>{cloud.status === 'off' ? 'Set up the cloud inbox in agent settings to see cards.' : 'This card is no longer in the inbox.'}</Text>}
      </View>
    </View>;
  }
  const open = card.state === 'open';
  const respond = (cardId: string, actionId: string) => { void cloud.respond(cardId, { actionId }); };
  const pick = (_: unknown, value: CardPick) => { void cloud.respond(card.id, { pick: value.n, done: !value.done }); };
  const actions = cardActions(card);
  const link = card.url && !actions.some((action) => action.url === card.url) ? card.url : undefined;
  const outcome = card.pendingAction ? `${actionLabel(card, card.pendingAction)}, sending`
    : card.resolution ? `${actionLabel(card, card.resolution.actionId)} by ${card.resolution.by} · ${new Date(card.resolution.at).toLocaleString()}`
      : open ? undefined : 'Settled';
  return <View style={uiStyles.screen}>
    <RelayHeader title={sourceLabels[card.source]} detail={cardAge(card)} onBack={onBack} />
    <ScrollView contentContainerStyle={[uiStyles.content, styles.content]}>
      <Text style={[styles.title, { fontSize: 22 * factor, lineHeight: 28 * factor }]} accessibilityRole="header">{card.title}</Text>
      {outcome ? <Text style={[styles.outcome, card.pendingAction === 'approve' || card.resolution?.actionId === 'approve' ? { color: colors.green } : null]}>{outcome}</Text> : null}
      {card.meta && Object.keys(card.meta).length ? <View style={styles.meta}>
        {Object.entries(card.meta).map(([label, value]) => <View key={label} style={styles.metaRow}>
          <Text style={[styles.metaLabel, { fontSize: 14 * factor }]}>{label}</Text>
          <Text style={[styles.metaValue, { fontSize: 14 * factor }]} selectable>{value}</Text>
        </View>)}
      </View> : null}
      {card.picks?.length ? <View style={styles.picks}><CardPicks card={card} onPick={open ? pick : () => {}} /></View> : null}
      {card.body ? <MessageContent text={card.body} /> : null}
      {open && !card.pendingAction && actions.length ? <View style={styles.actions}>
        {actions.map((action) => <RelayButton key={action.id} tone={action.style === 'primary' ? 'primary' : action.style === 'destructive' ? 'destructive' : 'default'} onPress={() => runAction(card, action, respond)}>{action.label}</RelayButton>)}
      </View> : null}
      {link ? <RelayButton onPress={() => openCardLink(link)}>Open link</RelayButton> : null}
    </ScrollView>
  </View>;
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  content: { paddingTop: 12, gap: 14 },
  title: { color: colors.primary, fontWeight: '600', letterSpacing: -0.3 },
  outcome: { color: colors.secondary, fontSize: 15, fontWeight: '600' },
  meta: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  metaRow: { flexDirection: 'row', gap: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  metaLabel: { color: colors.muted, fontWeight: '600', minWidth: 84 },
  metaValue: { color: colors.primary, flex: 1 },
  picks: { marginHorizontal: -8 },
  actions: { gap: 10, paddingTop: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { color: colors.secondary, fontSize: 15, lineHeight: 22, textAlign: 'center' },
});
