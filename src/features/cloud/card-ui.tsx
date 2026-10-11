import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';
import { memo, useRef, type ReactNode } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

import { useColors, useTextScale, useThemedStyles, type RelayPalette } from '@/features/relay/relay-ui';
import { dateLabel } from '@/features/relay/session-inbox';

import type { Card, CardAction, CardPick, Source } from '../../../cloud/src/contract';
import { isOpenableUrl, previewLine } from './card-text';
import type { InboxCard } from './inbox-rows';
import { glyphColors, SOURCE_STYLES } from './sources';

/** Width of a glyph plus its gap: picks and buttons line up with the text column. */
export const GLYPH_INSET = 42;

/** Only the actions the producer declared. The Worker rejects any other action id. */
export function cardActions(card: Card): readonly CardAction[] {
  return card.actions ?? [];
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

/**
 * Opens a card URL with the system, including app schemes like `scryve-preview://`, so the
 * owning app handles it. Script-capable schemes are refused.
 */
export function openCardLink(url: string) {
  if (!isOpenableUrl(url)) {
    Alert.alert('Cannot open this link', url);
    return;
  }
  void Linking.openURL(url).catch(() => Alert.alert('Could not open link', 'No app on this phone handles it.'));
}

/** Runs a card action: a URL action opens its link and records nothing; anything else is a response. */
export function runAction(card: Card, action: CardAction, respond: (cardId: string, actionId: string) => void) {
  if (action.url) openCardLink(action.url);
  else respond(card.id, action.id);
}

/** A 30pt round, source-colored glyph, like a Mail avatar. */
export function CardGlyph({ source }: { source: Source }) {
  const colors = useColors();
  const { background, foreground } = glyphColors(source, colors);
  const { symbol, label } = SOURCE_STYLES[source];
  return <View accessible={false} style={[glyphStyles.glyph, { backgroundColor: background }]}>
    <SymbolView
      name={{ ios: symbol.ios as SFSymbol, android: symbol.android as AndroidSymbol, web: symbol.android as AndroidSymbol }}
      size={15}
      tintColor={foreground}
      fallback={<Text style={[glyphStyles.fallback, { color: foreground }]}>{label[0]}</Text>}
    />
  </View>;
}

/** An outlined (or filled, for primary) button sized for inline card actions. */
export function CardButton({ action, onPress, label, wide = false }: { action: Pick<CardAction, 'label' | 'style'>; onPress: () => void; label?: string; wide?: boolean }) {
  const styles = useThemedStyles(createStyles);
  const { factor } = useTextScale();
  const primary = action.style === 'primary';
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label ?? action.label}
    hitSlop={wide ? 0 : 5}
    onPress={onPress}
    style={({ pressed }) => [styles.button, wide && styles.buttonWide, primary && styles.buttonPrimary, pressed && { opacity: 0.65 }]}
  >
    <Text numberOfLines={1} style={[styles.buttonText, primary && styles.buttonTextPrimary, action.style === 'destructive' && styles.destructive, { fontSize: 15 * factor }]}>{action.label}</Text>
  </Pressable>;
}

type SwipeAction = 'settle' | 'reopen';
const swipeLabels = { settle: 'Settle', reopen: 'Reopen' } as const satisfies Record<SwipeAction, string>;

/** VoiceOver's equivalent of the swipe, matching thread rows. */
function swipeAccessibility(action: SwipeAction | undefined, run: (action: SwipeAction) => void) {
  return action ? {
    accessibilityActions: [{ name: action, label: swipeLabels[action] }],
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => { if (event.nativeEvent.actionName === action) run(action); },
  } : {};
}

/** Swipe left to settle an open card, or to reopen one this phone settled (see `settleAction`). */
export function CardSwipe({ card, action, onRun, children }: { card: InboxCard; action?: SwipeAction; onRun: (action: SwipeAction) => void; children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  const swipe = useRef<SwipeableMethods>(null);
  if (!action) return children;
  const perform = () => { swipe.current?.close(); onRun(action); };
  return <Swipeable ref={swipe} overshootRight={false} renderRightActions={() => <Pressable accessibilityRole="button" accessibilityLabel={`${swipeLabels[action]} ${card.title}`} onPress={perform} style={styles.swipeAction}><Text style={styles.swipeText}>{swipeLabels[action]}</Text></Pressable>}>
    {children}
  </Swipeable>;
}

export function CardPicks({ card, onPick, inset = 0 }: { card: InboxCard; onPick: (card: InboxCard, pick: CardPick) => void; inset?: number }) {
  const styles = useThemedStyles(createStyles);
  const { factor } = useTextScale();
  const picks = card.picks?.slice(0, 3) ?? [];
  return <View>
    {picks.map((pick) => <Pressable
      key={pick.n}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: pick.done }}
      accessibilityLabel={`${pick.text}${pick.sub ? `, ${pick.sub}` : ''}`}
      onPress={() => onPick(card, pick)}
      style={({ pressed }) => [styles.pick, { paddingLeft: inset }, pressed && styles.pressed]}
    >
      <View style={[styles.pickMark, pick.done && styles.pickMarkDone]}><Text style={[styles.pickNumber, pick.done && styles.pickNumberDone]}>{pick.n}</Text></View>
      <View style={styles.pickText}>
        <Text style={[styles.pickTitle, pick.done && styles.pickTitleDone, { fontSize: 16 * factor, lineHeight: 22 * factor }]}>{pick.text}</Text>
        {pick.sub ? <Text style={[styles.pickSub, { fontSize: 13 * factor, lineHeight: 17 * factor }]}>{pick.sub}</Text> : null}
      </View>
    </Pressable>)}
  </View>;
}

/** "Saturday, Oct 10" for a morning card. */
export function briefingDay(card: Card): string {
  return new Date(card.createdAt).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * The morning card as the first inbox row: glyph and day, the calendar line, picks indented
 * to the text column, then Keep and Skip. After an answer it stays open with a compact
 * "Kept · 1 of 3 done" line and live picks.
 */
export const BriefingCard = memo(function BriefingCard({ card, onOpen, onPick, onAction, onSettle }: {
  card: InboxCard;
  onOpen: (card: InboxCard) => void;
  onPick: (card: InboxCard, pick: CardPick) => void;
  onAction: (card: InboxCard, action: CardAction) => void;
  onSettle?: (card: InboxCard) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { factor } = useTextScale();
  const { calendar, ...meta } = card.meta ?? {};
  const day = briefingDay(card);
  const picks = card.picks?.slice(0, 3) ?? [];
  const summary = card.acknowledged ? `${acknowledgedLabel(card, card.acknowledged)} · ${picks.filter((pick) => pick.done).length} of ${picks.length} done` : undefined;
  const actions = cardActions(card).filter((action) => !action.url);
  const swipe = onSettle ? 'settle' : undefined;
  const run = () => onSettle?.(card);
  return <CardSwipe card={card} action={swipe} onRun={run}>
    <View style={[styles.rowContainer, styles.briefing]}>
      <Pressable {...swipeAccessibility(swipe, run)} accessibilityRole="button" accessibilityLabel={`${SOURCE_STYLES[card.source].label}, ${day}${calendar ? `, ${calendar}` : ''}. Open card`} onPress={() => onOpen(card)} style={({ pressed }) => [styles.briefingHeader, pressed && styles.pressed]}>
        <CardGlyph source={card.source} />
        <View style={styles.body}>
          <Text style={[styles.briefingTitle, { fontSize: 17 * factor, lineHeight: 22 * factor }]} numberOfLines={1}>{day}</Text>
          {calendar ? <Text style={[styles.secondary, { fontSize: 14 * factor, lineHeight: 19 * factor }]} numberOfLines={1}>{calendar}</Text> : null}
        </View>
      </Pressable>
      <CardPicks card={card} onPick={onPick} inset={GLYPH_INSET} />
      {Object.entries(meta).map(([label, value]) => <Text key={label} style={[styles.secondary, styles.inset, { fontSize: 14 * factor, lineHeight: 19 * factor }]} numberOfLines={2}><Text style={styles.metaLabel}>{label} </Text>{value}</Text>)}
      {summary ? <Text style={[styles.summary, styles.inset, { fontSize: 14 * factor, lineHeight: 19 * factor }]} numberOfLines={1}>{summary}</Text>
        : actions.length ? <View style={[styles.actions, styles.inset]}>{actions.map((action) => <CardButton key={action.id} action={action} label={`${action.label} morning card`} onPress={() => onAction(card, action)} />)}</View> : null}
    </View>
  </CardSwipe>;
});

/**
 * An approval (title, preview, inline actions) or an update (title, source label and a
 * one-line preview) led by its source glyph. Settled cards are quiet and show no actions.
 */
export const CardRow = memo(function CardRow({ card, settled, swipe, onPress, onAction, onSettle, onReopen }: {
  card: InboxCard;
  settled: boolean;
  /** From `settleAction`: what a swipe may do with this card. */
  swipe?: SwipeAction;
  onPress: (card: InboxCard) => void;
  onAction: (card: InboxCard, action: CardAction) => void;
  onSettle?: (card: InboxCard) => void;
  onReopen?: (card: InboxCard) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const { factor } = useTextScale();
  const approval = card.kind === 'approval' && !settled;
  const source = SOURCE_STYLES[card.source].label;
  const preview = previewLine(card.body);
  const actions = approval && !card.pendingAction ? cardActions(card).filter((action) => !action.url) : [];
  const status = card.pendingAction ? actionLabel(card, card.pendingAction) : cardAge(card);
  const statusColor = card.pendingAction === 'approve' ? colors.green : card.pendingAction === 'reject' ? colors.red : approval ? colors.amber : colors.muted;
  // Actions are siblings of the row button, not children, so VoiceOver can reach them on their own.
  const run = (action: SwipeAction) => (action === 'settle' ? onSettle : onReopen)?.(card);
  const available = swipe && (swipe === 'settle' ? onSettle : onReopen) ? swipe : undefined;
  return <CardSwipe card={card} action={available} onRun={run}>
    <View style={styles.rowContainer}>
      <Pressable
        {...swipeAccessibility(available, run)}
        accessibilityRole="button"
        accessibilityLabel={`${source}: ${card.title}${card.pendingAction ? `, ${actionLabel(card, card.pendingAction).toLocaleLowerCase()}, sending` : approval ? ', needs you' : ''}${settled ? ', settled' : ''}`}
        onPress={() => onPress(card)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <CardGlyph source={card.source} />
        <View style={styles.body}>
          <View style={styles.titleLine}>
            <Text numberOfLines={settled ? 1 : 2} style={[styles.title, settled && styles.quiet, { fontSize: 17 * factor, lineHeight: 23 * factor }]}>{card.title}</Text>
            <Text numberOfLines={1} style={[styles.status, { color: statusColor, fontSize: 15 * factor, lineHeight: 23 * factor }]}>{status}</Text>
          </View>
          {settled ? null : approval ? (preview ? <Text numberOfLines={1} style={[styles.secondary, { fontSize: 15 * factor, lineHeight: 20 * factor }]}>{preview}</Text> : null)
            : <Text numberOfLines={1} style={[styles.secondary, { fontSize: 15 * factor, lineHeight: 20 * factor }]}><Text style={[styles.source, { fontSize: 13 * factor }]}>{source}  </Text>{preview ?? ''}</Text>}
        </View>
      </Pressable>
      {actions.length ? <View style={[styles.actions, styles.rowActions]}>{actions.map((action) => <CardButton key={action.id} action={action} label={`${action.label} ${card.title}`} onPress={() => onAction(card, action)} />)}</View> : null}
    </View>
  </CardSwipe>;
});

const glyphStyles = StyleSheet.create({
  glyph: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  fallback: { fontSize: 14, fontWeight: '700' },
});

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  rowContainer: { marginHorizontal: 12, backgroundColor: colors.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  briefing: { paddingHorizontal: 8, paddingTop: 6, paddingBottom: 12 },
  briefingHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, borderRadius: 6 },
  briefingTitle: { color: colors.primary, fontWeight: '600' },
  inset: { marginLeft: GLYPH_INSET },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 8, paddingVertical: 11, minHeight: 44, borderRadius: 6 },
  rowActions: { marginLeft: GLYPH_INSET + 8, marginTop: -3, paddingBottom: 12 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  pressed: { backgroundColor: colors.selectedThread },
  titleLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  title: { color: colors.primary, fontWeight: '500', flex: 1, minWidth: 0 },
  quiet: { color: colors.muted, fontWeight: '400' },
  status: { color: colors.muted },
  secondary: { color: colors.secondary },
  source: { color: colors.muted, fontWeight: '600' },
  metaLabel: { color: colors.muted, fontWeight: '600' },
  summary: { color: colors.secondary, fontWeight: '600', paddingTop: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 8 },
  button: { minHeight: 34, paddingHorizontal: 13, borderRadius: 10, borderWidth: 1, borderColor: colors.lineStrong, alignItems: 'center', justifyContent: 'center' },
  buttonWide: { flex: 1, minHeight: 44 },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { color: colors.primary, fontWeight: '600' },
  buttonTextPrimary: { color: colors.background },
  destructive: { color: colors.red },
  pick: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8, minHeight: 40, borderRadius: 4 },
  pickMark: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.lineStrong, alignItems: 'center', justifyContent: 'center' },
  pickMarkDone: { backgroundColor: colors.green, borderColor: colors.green },
  pickNumber: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  pickNumberDone: { color: colors.background },
  pickText: { flex: 1, minWidth: 0 },
  pickTitle: { color: colors.primary },
  pickTitleDone: { color: colors.muted, textDecorationLine: 'line-through' },
  pickSub: { color: colors.muted },
  swipeAction: { backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', minWidth: 84, paddingHorizontal: 16 },
  swipeText: { color: colors.background, fontWeight: '600', fontSize: 15 },
});
