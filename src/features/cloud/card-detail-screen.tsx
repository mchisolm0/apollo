import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { MessageContent } from '@/features/relay/message-content';
import { IconButton, useColors, useRelayStyles, useTextScale, useThemedStyles, type RelayPalette } from '@/features/relay/relay-ui';
import { useApollo } from '@/lib';

import type { CardAction, CardLink, CardMetric, CardPick } from '../../../cloud/src/contract';
import { acknowledgedLabel, actionLabel, CardButton, cardActions, CardGlyph, CardPicks, CardProgressBar, openCardLink, runAction } from './card-ui';
import { useCloud } from './cloud-context';
import { settleAction, settleOnFirstSight, type InboxCard } from './inbox-rows';
import { parseApolloLink } from './card-text';
import { SOURCE_STYLES } from './sources';

/** "Mon 08:00" in the phone's locale. */
function stamp(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function copyText(card: InboxCard): string {
  const meta = Object.entries(card.meta ?? {}).map(([label, value]) => `${label}: ${value}`);
  const metrics = (card.metrics ?? []).map((metric) => `${metric.label}: ${metric.value}${metric.unit ? ` ${metric.unit}` : ''}${metric.delta ? ` (${metric.delta})` : ''}`);
  return [card.title, [...meta, ...metrics].join('\n'), card.body ?? '', card.url ?? ''].filter(Boolean).join('\n\n');
}

/** Up to four figures with label, unit and a delta colored by trend. */
function MetricRow({ metrics }: { metrics: readonly CardMetric[] }) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const { factor } = useTextScale();
  return <View style={styles.metrics} accessibilityRole="summary">
    {metrics.slice(0, 4).map((metric, index) => <View key={`${metric.label}:${index}`} style={[styles.metric, index > 0 && styles.metricDivided]} accessible accessibilityLabel={`${metric.label}: ${metric.value}${metric.unit ? ` ${metric.unit}` : ''}${metric.delta ? `, ${metric.delta}` : ''}`}>
      <Text style={[styles.metricValue, { fontSize: 22 * factor, lineHeight: 27 * factor }]} numberOfLines={1} adjustsFontSizeToFit>
        {metric.value}{metric.unit ? <Text style={[styles.metricUnit, { fontSize: 13 * factor }]}> {metric.unit}</Text> : null}
      </Text>
      <Text style={[styles.metricLabel, { fontSize: 12 * factor, lineHeight: 16 * factor }]} numberOfLines={2}>{metric.label}</Text>
      {metric.delta ? <Text style={[styles.metricDelta, { color: metric.trend === 'good' ? colors.green : metric.trend === 'bad' ? colors.red : colors.muted, fontSize: 12 * factor, lineHeight: 16 * factor }]} numberOfLines={1}>{metric.delta}</Text> : null}
    </View>)}
  </View>;
}

/** A tappable "Replaces <title>" line that opens the other card. */
function LinkedCard({ label, link }: { label: string; link: CardLink }) {
  const styles = useThemedStyles(createStyles);
  const { factor } = useTextScale();
  return <Pressable accessibilityRole="link" accessibilityLabel={`${label} ${link.title}`} onPress={() => router.push({ pathname: '/card/[id]', params: { id: link.id } })} style={({ pressed }) => [styles.metaRow, pressed && { opacity: 0.65 }]}>
    <Text style={[styles.metaLabel, { fontSize: 14 * factor, lineHeight: 20 * factor }]}>{label}</Text>
    <Text style={[styles.linkValue, { fontSize: 14 * factor, lineHeight: 20 * factor }]} numberOfLines={1}>{link.title}</Text>
  </Pressable>;
}

const MAX_TEXT = 4000;

/** Inline text for an `input` action: Send records it, Cancel drops it. */
function Composer({ action, onSend, onCancel }: { action: CardAction; onSend: (text: string) => void; onCancel: () => void }) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const { factor } = useTextScale();
  const [draft, setDraft] = useState('');
  const text = draft.trim();
  return <View style={styles.composer}>
    <TextInput
      autoFocus
      multiline
      value={draft}
      onChangeText={setDraft}
      maxLength={MAX_TEXT}
      placeholder={action.label}
      placeholderTextColor={colors.muted}
      accessibilityLabel={action.label}
      style={[styles.composerInput, { fontSize: 16 * factor, lineHeight: 22 * factor }]}
    />
    <View style={styles.composerBar}>
      <CardButton wide action={{ label: 'Cancel' }} onPress={onCancel} />
      <CardButton wide action={{ label: 'Send', style: text ? 'primary' : 'default' }} onPress={() => { if (text) onSend(text); }} />
    </View>
  </View>;
}

/** Full card: source header, title, meta, metrics, picks, markdown body and a bottom action bar. */
export function CardDetailScreen({ cardId, onBack }: { cardId: string; onBack: () => void }) {
  const styles = useThemedStyles(createStyles);
  const uiStyles = useRelayStyles();
  const colors = useColors();
  const { factor } = useTextScale();
  const cloud = useCloud();
  const { agents } = useApollo();
  const [copied, setCopied] = useState(false);
  const [composing, setComposing] = useState<CardAction>();
  const [sent, setSent] = useState(false);
  const card = cloud.cards.find((candidate) => candidate.id === cardId);
  // Opening an update settles it, from a row or a notification alike, once per mount, so Reopen here sticks.
  const { settle: settleCard, settled: settledCards } = cloud;
  const seen = useRef<string>(undefined);
  useEffect(() => {
    const decision = settleOnFirstSight(seen.current, card, settledCards);
    seen.current = decision.seen;
    if (decision.settle && card) settleCard(card.id);
  }, [card, settledCards, settleCard]);
  if (!card) {
    const waiting = cloud.status !== 'off' && !cloud.ready;
    return <View style={uiStyles.screen}>
      <View style={styles.header}><IconButton name="chevron.left" label="Go back" onPress={onBack} /></View>
      <View style={styles.empty}>
        {waiting ? <ActivityIndicator color={colors.secondary} accessibilityLabel="Loading card" /> : <Text style={styles.emptyText}>{cloud.status === 'off' ? 'Set up the cloud inbox in agent settings to see cards.' : 'This card is no longer in the inbox.'}</Text>}
      </View>
    </View>;
  }
  const open = card.state === 'open';
  const swipe = settleAction(card, cloud.settled);
  const respond = (id: string, actionId: string) => { void cloud.respond(id, { actionId }); };
  const pick = (_: InboxCard, value: CardPick) => { void cloud.respond(card.id, { pick: value.n, done: !value.done }); };
  const host = agents.find((agent) => agent.id === cloud.credential?.agentId)?.label;
  const outcome = card.sending ? 'Sending' : sent ? 'Sent'
    : card.acknowledged ? acknowledgedLabel(card, card.acknowledged)
    : card.pendingAction ? `${actionLabel(card, card.pendingAction)}, sending`
      : card.resolution ? `${actionLabel(card, card.resolution.actionId)} by ${card.resolution.by} · ${stamp(card.resolution.at)}`
        : open ? undefined : 'Settled';
  // An open approval, or a morning card not yet kept or skipped, answers from the bar; everything else gets Copy and Settle.
  // A keepOpen approval stays open after its answer, so a resolution counts as answered too.
  const unanswered = open && (card.kind === 'approval' ? !card.pendingAction && !card.resolution : card.kind === 'briefing' && !card.acknowledged);
  // A repeat action, like Reply, stays available for as long as the card is open.
  const decide = cardActions(card).filter((action) => unanswered || (open && action.repeat));
  const onlyRepeats = decide.length > 0 && !unanswered;
  const run = (action: CardAction) => action.input ? setComposing(action) : runAction(card, action, respond);
  const send = (action: CardAction, text: string) => {
    setComposing(undefined);
    void cloud.respond(card.id, { actionId: action.id, text }).then(() => {
      setSent(true);
      setTimeout(() => setSent(false), 1500);
    });
  };
  const link = card.url && !decide.some((action) => action.url === card.url) ? card.url : undefined;
  const copy = () => void Clipboard.setStringAsync(copyText(card)).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }).catch(() => Alert.alert('Could not copy', 'Try selecting the text instead.'));
  const settle = () => { cloud.settle(card.id); onBack(); };
  const meta = Object.entries(card.meta ?? {});
  return <KeyboardAvoidingView style={uiStyles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={styles.header}>
      <IconButton name="chevron.left" label="Go back" onPress={onBack} />
      <CardGlyph source={card.source} />
      <View style={styles.headerText}>
        <Text style={[styles.headerTitle, { fontSize: 16 * factor }]} numberOfLines={1}>{SOURCE_STYLES[card.source].label}</Text>
        <Text style={[styles.headerDetail, { fontSize: 12 * factor }]} numberOfLines={1}>{host ? `${stamp(card.createdAt)} · ${host}` : stamp(card.createdAt)}</Text>
      </View>
    </View>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[styles.title, { fontSize: 24 * factor, lineHeight: 30 * factor }]} accessibilityRole="header" selectable>{card.title}</Text>
      {outcome ? <Text style={[styles.outcome, (card.pendingAction ?? card.resolution?.actionId) === 'approve' && { color: colors.green }, { fontSize: 15 * factor }]}>{outcome}</Text> : null}
      {card.progress && open ? <CardProgressBar progress={card.progress} /> : null}
      {card.replaces ? <LinkedCard label="Replaces" link={card.replaces} /> : null}
      {card.replacedBy ? <LinkedCard label="Replaced by" link={card.replacedBy} /> : null}
      {meta.length ? <View style={styles.meta}>
        {meta.map(([label, value]) => <View key={label} style={styles.metaRow}>
          <Text style={[styles.metaLabel, { fontSize: 14 * factor, lineHeight: 20 * factor }]}>{label}</Text>
          <Text style={[styles.metaValue, { fontSize: 14 * factor, lineHeight: 20 * factor }]} selectable>{value}</Text>
        </View>)}
      </View> : null}
      {card.metrics?.length ? <MetricRow metrics={card.metrics} /> : null}
      {card.picks?.length ? <CardPicks card={card} onPick={open ? pick : () => {}} /> : null}
      {card.body && card.plainText ? <Text style={[styles.plainBody, { fontSize: 15 * factor, lineHeight: 22 * factor }]} selectable>{card.body}</Text>
        : card.body ? <MessageContent text={card.body} copyable={false} /> : null}
    </ScrollView>
    {composing ? <Composer key={composing.id} action={composing} onSend={(text) => send(composing, text)} onCancel={() => setComposing(undefined)} /> : <View style={styles.bar}>
      {decide.length ? <>
        {decide.map((action: CardAction) => <CardButton key={action.id} wide action={action} onPress={() => run(action)} />)}
        {link ? <CardButton wide action={{ label: parseApolloLink(link)?.kind === 'session' ? 'Open thread' : 'Open link' }} onPress={() => void openCardLink(link)} /> : null}
        {onlyRepeats && swipe === 'settle' ? <CardButton wide action={{ label: 'Settle' }} onPress={settle} /> : null}
      </> : <>
        <CardButton wide action={{ label: copied ? 'Copied' : 'Copy' }} onPress={copy} />
        {link ? <CardButton wide action={{ label: 'Open' }} onPress={() => void openCardLink(link)} /> : null}
        {swipe === 'settle' ? <CardButton wide action={{ label: 'Settle', style: 'primary' }} onPress={settle} />
          : swipe === 'reopen' ? <CardButton wide action={{ label: 'Reopen' }} onPress={() => cloud.reopen(card.id)} /> : null}
      </>}
    </View>}
  </KeyboardAvoidingView>;
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingLeft: 6, paddingRight: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  headerText: { flex: 1, minWidth: 0 },
  headerTitle: { color: colors.primary, fontWeight: '600' },
  headerDetail: { color: colors.muted, fontVariant: ['tabular-nums'] },
  content: { padding: 16, paddingBottom: 28, gap: 12 },
  title: { color: colors.primary, fontWeight: '700', letterSpacing: -0.3 },
  outcome: { color: colors.secondary, fontWeight: '600' },
  meta: { gap: 4 },
  metaRow: { flexDirection: 'row', gap: 14 },
  metaLabel: { color: colors.muted, minWidth: 64 },
  metaValue: { color: colors.secondary, flex: 1, fontVariant: ['tabular-nums'] },
  linkValue: { color: colors.cyan, flex: 1 },
  plainBody: { color: colors.primary },
  metrics: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  metric: { flex: 1, minWidth: 0, paddingVertical: 10 },
  metricDivided: { paddingLeft: 12, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
  metricValue: { color: colors.primary, fontWeight: '700', fontVariant: ['tabular-nums'] },
  metricUnit: { color: colors.muted, fontWeight: '500' },
  metricLabel: { color: colors.muted },
  metricDelta: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  bar: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  composer: { gap: 8, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  composerInput: { color: colors.primary, minHeight: 88, maxHeight: 200, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.lineStrong, textAlignVertical: 'top' },
  composerBar: { flexDirection: 'row', gap: 8 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { color: colors.secondary, fontSize: 15, lineHeight: 22, textAlign: 'center' },
});
