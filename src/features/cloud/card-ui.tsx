import { memo } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { useColors, useTextScale, useThemedStyles, type RelayPalette } from '@/features/relay/relay-ui';
import { dateLabel } from '@/features/relay/session-inbox';

import type { Card, CardAction, CardPick, Source } from '../../../cloud/src/contract';
import type { InboxCard } from './inbox-rows';

export const sourceLabels = {
  morning: 'Morning', preview: 'Preview', fleet: 'Fleet', digest: 'Digest', jobs: 'Jobs', hermes: 'Hermes',
} as const satisfies Record<Source, string>;

/** Only the actions the producer declared. The Worker rejects any other action id. */
export function cardActions(card: Card): readonly CardAction[] {
  return card.actions ?? [];
}

function inlineAction(card: Card): CardAction | undefined {
  const actions = cardActions(card).filter((action) => !action.url);
  return actions.find((action) => action.id === 'approve') ?? actions.find((action) => action.style === 'primary') ?? actions[0];
}

export function actionLabel(card: Card, actionId: string): string {
  const label = cardActions(card).find((action) => action.id === actionId)?.label;
  return actionId === 'approve' ? 'Approved' : actionId === 'reject' ? 'Rejected' : label ?? actionId;
}

/** "Kept", "Skipped", or the action's own label for anything else. */
export function acknowledgedLabel(card: Card, actionId: string): string {
  if (actionId === 'keep') return 'Kept';
  if (actionId === 'skip') return 'Skipped';
  return cardActions(card).find((action) => action.id === actionId)?.label ?? actionId;
}

export function cardAge(card: Card): string {
  return dateLabel(Math.floor(Date.parse(card.updatedAt) / 1000));
}

export function openCardLink(url: string) {
  if (!/^https?:\/\//iu.test(url)) {
    Alert.alert('Cannot open this link', 'Only HTTP and HTTPS links can be opened from a card.');
    return;
  }
  void Linking.openURL(url).catch(() => Alert.alert('Could not open link', 'Try again later.'));
}

/** Runs a card action: a URL action opens its link and records nothing; anything else is a response. */
export function runAction(card: Card, action: CardAction, respond: (cardId: string, actionId: string) => void) {
  if (action.url) openCardLink(action.url);
  else respond(card.id, action.id);
}

export function CardPicks({ card, onPick }: { card: InboxCard; onPick: (card: InboxCard, pick: CardPick) => void }) {
  const styles = useThemedStyles(createStyles);
  const { factor } = useTextScale();
  const picks = card.picks?.slice(0, 3) ?? [];
  return <View>
    {picks.map((pick, index) => <Pressable
      key={pick.n}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: pick.done }}
      accessibilityLabel={`${pick.text}${pick.sub ? `, ${pick.sub}` : ''}`}
      onPress={() => onPick(card, pick)}
      style={({ pressed }) => [styles.pick, index === picks.length - 1 && styles.pickLast, pressed && styles.pressed]}
    >
      <View style={[styles.pickMark, pick.done && styles.pickMarkDone]}><Text style={[styles.pickNumber, pick.done && styles.pickNumberDone]}>{pick.n}</Text></View>
      <View style={styles.pickText}>
        <Text style={[styles.pickTitle, pick.done && styles.pickTitleDone, { fontSize: 16 * factor, lineHeight: 22 * factor }]}>{pick.text}</Text>
        {pick.sub ? <Text style={[styles.pickSub, { fontSize: 13 * factor, lineHeight: 17 * factor }]}>{pick.sub}</Text> : null}
      </View>
    </Pressable>)}
  </View>;
}

/**
 * The morning card pinned to the top of the inbox: date and calendar, then up to three picks.
 * After Keep or Skip it stays open with a compact "Kept · 1 of 3 done" header and live picks.
 */
export const BriefingCard = memo(function BriefingCard({ card, onOpen, onPick, onAction }: {
  card: InboxCard;
  onOpen: (card: InboxCard) => void;
  onPick: (card: InboxCard, pick: CardPick) => void;
  onAction: (card: InboxCard, action: CardAction) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { factor } = useTextScale();
  const { calendar, ...meta } = card.meta ?? {};
  const date = new Date(card.createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toLocaleUpperCase();
  const picks = card.picks?.slice(0, 3) ?? [];
  const summary = card.acknowledged ? `${acknowledgedLabel(card, card.acknowledged)} · ${picks.filter((pick) => pick.done).length} of ${picks.length} done` : undefined;
  return <View style={styles.briefing}>
    <View style={styles.briefingHeader}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${card.title}, ${date}${calendar ? `, ${calendar}` : ''}. Open card`} onPress={() => onOpen(card)} style={styles.briefingDate}>
        <Text style={[styles.briefingDateText, { fontSize: 13 * factor, lineHeight: 18 * factor }]} numberOfLines={1}>{calendar ? `${date} · ${calendar}` : date}</Text>
      </Pressable>
      {summary ? <Text style={[styles.summary, { fontSize: 13 * factor }]} numberOfLines={1}>{summary}</Text> : null}
      {summary ? null : cardActions(card).map((action) => <Pressable key={action.id} accessibilityRole="button" accessibilityLabel={`${action.label} morning card`} onPress={() => onAction(card, action)} style={({ pressed }) => [styles.textAction, pressed && { opacity: 0.6 }]}>
        <Text style={[styles.textActionLabel, action.style === 'destructive' && styles.destructive, { fontSize: 15 * factor }]}>{action.label}</Text>
      </Pressable>)}
    </View>
    <CardPicks card={card} onPick={onPick} />
    {Object.entries(meta).map(([label, value]) => <Text key={label} style={[styles.meta, { fontSize: 14 * factor, lineHeight: 19 * factor }]} numberOfLines={2}><Text style={styles.metaLabel}>{label} </Text>{value}</Text>)}
  </View>;
});

/** A card in Needs you (with an inline primary action) or Updates. */
export const CardRow = memo(function CardRow({ card, onPress, onAction }: {
  card: InboxCard;
  onPress: (card: InboxCard) => void;
  onAction: (card: InboxCard, action: CardAction) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const { factor } = useTextScale();
  const approval = card.kind === 'approval';
  const action = approval ? inlineAction(card) : undefined;
  const preview = card.body?.split('\n').find((line) => line.trim())?.trim();
  const status = card.pendingAction ? actionLabel(card, card.pendingAction) : approval ? undefined : card.url ? 'Open' : cardAge(card);
  const statusColor = card.pendingAction === 'approve' ? colors.green : card.pendingAction === 'reject' ? colors.red : !approval && card.url ? colors.cyan : colors.secondary;
  // The inline action is a sibling of the row, not a child, so VoiceOver can reach it on its own.
  return <View style={[styles.rowContainer, styles.rowLine]}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${sourceLabels[card.source]}: ${card.title}${card.pendingAction ? `, ${actionLabel(card, card.pendingAction).toLocaleLowerCase()}, sending` : approval ? ', needs you' : ''}`}
      onPress={() => onPress(card)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.titleLine}>
        <Text numberOfLines={2} style={[styles.title, !approval && styles.updateTitle, { fontSize: (approval ? 17 : 16) * factor, lineHeight: 23 * factor }]}>{card.title}</Text>
        {status ? <Text numberOfLines={1} style={[styles.status, { color: statusColor, fontSize: 15 * factor, lineHeight: 23 * factor }]}>{status}</Text> : null}
      </View>
      {approval && preview ? <Text numberOfLines={1} style={[styles.preview, { fontSize: 15 * factor, lineHeight: 20 * factor }]}>{preview}</Text> : null}
    </Pressable>
    {!status && action ? <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${action.label} ${card.title}`}
      hitSlop={6}
      onPress={() => onAction(card, action)}
      style={({ pressed }) => [styles.inlineButton, action.style === 'destructive' && styles.inlineButtonDestructive, pressed && { opacity: 0.65 }]}
    ><Text style={[styles.inlineButtonText, action.style === 'destructive' && styles.destructive, { fontSize: 15 * factor }]}>{action.label}</Text></Pressable> : null}
  </View>;
});

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  briefing: { marginHorizontal: 12, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 8 },
  briefingHeader: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44 },
  briefingDate: { flex: 1, minHeight: 44, justifyContent: 'center' },
  briefingDateText: { color: colors.muted, fontWeight: '600', letterSpacing: 0.3 },
  summary: { color: colors.secondary, fontWeight: '600' },
  textAction: { minHeight: 44, minWidth: 44, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  textActionLabel: { color: colors.cyan, fontWeight: '600' },
  destructive: { color: colors.red },
  pick: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 10, minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, borderRadius: 4 },
  pickLast: { borderBottomWidth: 0 },
  pickMark: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.lineStrong, alignItems: 'center', justifyContent: 'center' },
  pickMarkDone: { backgroundColor: colors.green, borderColor: colors.green },
  pickNumber: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  pickNumberDone: { color: colors.background },
  pickText: { flex: 1, minWidth: 0 },
  pickTitle: { color: colors.primary },
  pickTitleDone: { color: colors.muted, textDecorationLine: 'line-through' },
  pickSub: { color: colors.muted },
  meta: { color: colors.secondary, paddingTop: 6 },
  metaLabel: { color: colors.muted, fontWeight: '600' },
  rowContainer: { marginHorizontal: 12, backgroundColor: colors.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  row: { flex: 1, minWidth: 0, paddingHorizontal: 8, paddingVertical: 12, minHeight: 44, borderRadius: 6, gap: 4, justifyContent: 'center' },
  pressed: { backgroundColor: colors.selectedThread },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { color: colors.primary, fontWeight: '500', flex: 1, minWidth: 0 },
  updateTitle: { fontWeight: '400' },
  status: { color: colors.secondary },
  preview: { color: colors.secondary },
  inlineButton: { marginRight: 8, minHeight: 34, paddingHorizontal: 14, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  inlineButtonDestructive: { backgroundColor: colors.dangerSurface },
  inlineButtonText: { color: colors.background, fontWeight: '600' },
});
