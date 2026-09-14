import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { SymbolView } from 'expo-symbols';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ConnectionState, RunEventKind } from './types';

export const relayColors = {
  background: '#000000',
  surface: '#1c1c1e',
  elevated: '#222224',
  line: '#292929',
  lineStrong: '#38383a',
  primary: '#ffffff',
  secondary: '#aaaaaa',
  muted: '#929298',
  cyan: '#a7c8ff',
  amber: '#f3b842',
  red: '#ff5363',
  green: '#69d391',
} as const;

export const relaySpacing = {
  page: 16,
  compact: 8,
  control: 12,
  section: 24,
} as const;

export const relayTypography = {
  title: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 22 },
  caption: { fontSize: 12, lineHeight: 16 },
} as const;

// Local-only reading text size. Dark mode only, no theme switch. Persisted across
// relaunch; multiplies base sizes so the system fontScale keeps applying on top.
export type TextScaleKey = 'small' | 'default' | 'large';
export const TEXT_SCALE_FACTORS: Record<TextScaleKey, number> = { small: 0.875, default: 1, large: 1.18 };
export const TEXT_SCALE_STORAGE_KEY = 'ekho:text-scale';

export function parseTextScale(value: unknown): TextScaleKey {
  return value === 'small' || value === 'large' ? value : 'default';
}

type TextScaleValue = { scale: TextScaleKey; factor: number; setScale: (next: TextScaleKey) => Promise<void> };

const TextScaleContext = createContext<TextScaleValue>({ scale: 'default', factor: 1, setScale: async () => undefined });

export function TextScaleProvider({ children }: { children: ReactNode }) {
  const [scale, setScaleState] = useState<TextScaleKey>('default');
  useEffect(() => {
    void AsyncStorage.getItem(TEXT_SCALE_STORAGE_KEY)
      .then((saved) => setScaleState(parseTextScale(saved)))
      .catch(() => undefined);
  }, []);
  const setScale = useCallback(async (next: TextScaleKey) => {
    setScaleState(next);
    try {
      await AsyncStorage.setItem(TEXT_SCALE_STORAGE_KEY, next);
    } catch {
      // Keep the in-memory value; storage stays on best effort.
    }
  }, []);
  const value = useMemo(() => ({ scale, factor: TEXT_SCALE_FACTORS[scale], setScale }), [scale, setScale]);
  return <TextScaleContext.Provider value={value}>{children}</TextScaleContext.Provider>;
}

export function useTextScale(): TextScaleValue {
  return useContext(TextScaleContext);
}

type ButtonTone = 'default' | 'route' | 'primary' | 'amber' | 'destructive';

export function RelayButton({
  children,
  tone = 'default',
  compact = false,
  ...props
}: ComponentProps<typeof Pressable> & { children: ReactNode; tone?: ButtonTone; compact?: boolean }) {
  const color = props.disabled ? relayColors.muted : tone === 'route' || tone === 'primary' ? relayColors.background : tone === 'amber' ? relayColors.amber : tone === 'destructive' ? relayColors.red : relayColors.primary;
  const backgroundColor = props.disabled
    ? relayColors.elevated
    : tone === 'route' || tone === 'primary'
      ? relayColors.primary
      : tone === 'amber'
        ? '#2c2412'
        : tone === 'destructive'
          ? '#2c1619'
          : relayColors.surface;
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ ...props.accessibilityState, disabled: Boolean(props.disabled) }}
      style={({ pressed }) => [styles.button, compact && styles.buttonCompact, { backgroundColor, opacity: pressed ? 0.65 : 1 }]}
    >
      <Text style={[styles.buttonText, { color }]}>{children}</Text>
    </Pressable>
  );
}

const androidSymbols: Record<string, AndroidSymbol> = {
  'sidebar.left': 'menu',
  'line.3.horizontal': 'menu',
  'line.3.horizontal.decrease': 'filter_list',
  'chevron.left': 'chevron_left',
  ellipsis: 'more_horiz',
  plus: 'add',
  'arrow.up': 'arrow_upward',
  'stop.fill': 'stop',
  magnifyingglass: 'search',
  'square.and.pencil': 'edit_square',
  xmark: 'close',
  'chevron.down': 'expand_more',
};

const fallbackGlyphs: Record<string, string> = {
  'sidebar.left': '☰',
  'line.3.horizontal': '☰',
  'line.3.horizontal.decrease': '≡',
  'chevron.left': '‹',
  ellipsis: '⋯',
  plus: '+',
  'arrow.up': '↑',
  'stop.fill': '■',
  magnifyingglass: '⌕',
  'square.and.pencil': '✎',
  xmark: '×',
  'chevron.down': '⌄',
};

export type IconButtonProps = {
  name: string;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  selected?: boolean;
  size?: number;
  tone?: 'default' | 'primary' | 'destructive';
};

/** A native symbol with a 44pt touch target and a Material Symbols fallback. */
export function IconButton({ name, label, onPress, disabled = false, selected = false, size = 44, tone = 'default' }: IconButtonProps) {
  const iconSize = Math.min(22, Math.max(16, size * 0.5));
  const materialName = androidSymbols[name];
  const tintColor = tone === 'destructive' ? relayColors.red : tone === 'primary' ? relayColors.background : relayColors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, { width: size, height: size, borderRadius: size / 2 }, tone === 'primary' && styles.iconButtonPrimary, tone === 'destructive' && styles.iconButtonDestructive, selected && styles.iconButtonSelected, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      <SymbolView
        name={{ ios: name as SFSymbol, android: materialName, web: materialName }}
        size={iconSize}
        tintColor={tintColor}
        fallback={<Text style={[styles.iconFallback, { color: tintColor, fontSize: iconSize }]}>{fallbackGlyphs[name] ?? '•'}</Text>}
      />
    </Pressable>
  );
}

export function RelayHeader({ title, detail, onBack, action, backLabel = 'Go back', backIcon = 'chevron.left' }: { title: string; detail?: string; onBack?: () => void; action?: ReactNode; backLabel?: string; backIcon?: string }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerLead}>
        {onBack ? <IconButton name={backIcon} label={backLabel} onPress={onBack} /> : null}
        <View style={{ flexShrink: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {detail ? <Text style={styles.headerDetail} numberOfLines={1}>{detail}</Text> : null}
        </View>
      </View>
      {action}
    </View>
  );
}

export function ConnectionMark({ state, label }: { state: ConnectionState; label?: boolean }) {
  const color = state === 'connected' ? relayColors.green : state === 'connecting' ? relayColors.amber : state === 'revoked' ? relayColors.red : relayColors.muted;
  const copy = connectionLabels[state];
  return (
    <View style={styles.connectionMark} accessible accessibilityRole="text" accessibilityLabel={`Connection: ${copy}`}>
      <View style={[styles.connectionDot, { backgroundColor: color }]} />
      {label ? <Text style={[styles.connectionText, { color }]}>{copy}</Text> : null}
    </View>
  );
}

export const connectionLabels = {
  connected: 'Connected',
  connecting: 'Reconnecting',
  offline: 'Offline',
  revoked: 'Access revoked',
} as const;

/** Connection trouble occupies the existing header instead of inserting a banner. */
export function ConnectionAction({ state, onReconnect, onDetails }: { state: ConnectionState; onReconnect?: () => void; onDetails?: () => void }) {
  if (state === 'connected') return null;
  const label = state === 'offline' ? 'Offline · Retry' : connectionLabels[state];
  const showDetails = () => Alert.alert(
    connectionLabels[state],
    state === 'revoked' ? 'This device no longer has access. Pair again to reconnect.' : 'Trying to reconnect. Your drafts are saved and you can keep writing.',
    [
      { text: 'Close', style: 'cancel' },
      ...(state === 'revoked' && onDetails ? [{ text: 'Agent details', onPress: onDetails }] : []),
    ],
  );
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={state === 'offline' ? 'Agent offline. Retry connection' : `${connectionLabels[state]}. Connection details`}
    onPress={state === 'offline' && onReconnect ? onReconnect : showDetails}
    style={({ pressed }) => [styles.connectionAction, { opacity: pressed ? 0.6 : 1 }]}
  >
    <Text numberOfLines={1} style={[styles.connectionText, { color: state === 'revoked' ? relayColors.red : relayColors.amber }]}>{label}</Text>
  </Pressable>;
}

export function Hairline() {
  return <View style={styles.hairline} />;
}

export function SectionLabel({ children, detail }: { children: string; detail?: string }) {
  return (
    <View style={styles.sectionLabel}>
      <Text style={styles.sectionLabelText}>{children}</Text>
      {detail ? <Text style={styles.sectionLabelDetail}>{detail}</Text> : null}
    </View>
  );
}

export function RelayInput(props: ComponentProps<typeof TextInput>) {
  return <TextInput {...props} placeholderTextColor={relayColors.muted} selectionColor={relayColors.cyan} style={[styles.input, props.style]} />;
}

export function StatusGlyph({ kind }: { kind: RunEventKind }) {
  const config: Record<RunEventKind, { glyph: string; color: string }> = {
    user: { glyph: '→', color: relayColors.cyan },
    assistant: { glyph: '◆', color: relayColors.primary },
    tool: { glyph: '↳', color: relayColors.amber },
    system: { glyph: '·', color: relayColors.muted },
    error: { glyph: '×', color: relayColors.red },
  };
  const item = config[kind];
  return <Text style={[styles.statusGlyph, { color: item.color }]} accessibilityLabel={`${kind} event`}>{item.glyph}</Text>;
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: relayColors.background },
  content: { flexGrow: 1, paddingHorizontal: relaySpacing.page, paddingBottom: 28 },
  header: { minHeight: 62, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, gap: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerLead: { flexDirection: 'row', alignItems: 'center', gap: relaySpacing.compact, flex: 1 },
  title: { color: relayColors.primary, ...relayTypography.title, letterSpacing: -0.25 },
  headerDetail: { color: relayColors.secondary, ...relayTypography.caption, marginTop: 2 },
  iconButton: { alignItems: 'center', justifyContent: 'center', backgroundColor: relayColors.background },
  iconButtonPrimary: { backgroundColor: relayColors.primary },
  iconButtonDestructive: { backgroundColor: '#2c1619' },
  iconButtonSelected: { borderWidth: 1, borderColor: relayColors.primary },
  iconFallback: { color: relayColors.primary, lineHeight: 22, textAlign: 'center' },
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  buttonCompact: { minHeight: 44, paddingHorizontal: 13, borderRadius: 10 },
  buttonText: { fontSize: 15, fontWeight: '600', letterSpacing: 0.1 },
  connectionMark: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  connectionDot: { width: 7, height: 7, borderRadius: 4 },
  connectionAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4, flexShrink: 1 },
  connectionText: { fontSize: 12, fontWeight: '600' },
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: relayColors.line },
  sectionLabel: { paddingTop: 24, paddingBottom: 9, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sectionLabelText: { color: relayColors.secondary, fontSize: 12, fontWeight: '600', letterSpacing: 0.4 },
  sectionLabelDetail: { color: relayColors.muted, fontSize: 11 },
  input: { minHeight: 48, borderRadius: 12, color: relayColors.primary, backgroundColor: relayColors.surface, paddingHorizontal: 13, paddingVertical: 10, fontSize: 16 },
  statusGlyph: { width: 24, fontSize: 17, lineHeight: 22, fontWeight: '600', textAlign: 'center' },
});
