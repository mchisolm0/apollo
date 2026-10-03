import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { SymbolView } from 'expo-symbols';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, PanResponder, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ConnectionState, RunEventKind } from './types';
import {
  CODE_CUSTOM_STORAGE_KEY,
  CODE_SIZE_DEFAULT,
  CODE_SIZE_MAX,
  CODE_SIZE_MIN,
  CODE_SIZE_STORAGE_KEY,
  TEXT_SIZE_DEFAULT,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  TEXT_SIZE_STORAGE_KEY,
  clampSize,
  parseCodeSize,
  parseEnabled,
  parseTextSize,
} from './text-size';
import { THEME_PALETTES, parseTheme, THEME_STORAGE_KEY, type ThemeId, type RelayPalette } from './theme';

export const relayColors: RelayPalette = THEME_PALETTES.code;

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

// Local-only reading text size in points (14–22, default 17). Terminal/code
// blocks can follow their own size when custom code size is enabled. Persisted
// across relaunch; multiplies base sizes so the system fontScale keeps applying
// on top.
export {
  TEXT_SIZE_MIN,
  TEXT_SIZE_MAX,
  TEXT_SIZE_DEFAULT,
  CODE_SIZE_MIN,
  CODE_SIZE_MAX,
  CODE_SIZE_DEFAULT,
  TEXT_SIZE_STORAGE_KEY,
  CODE_SIZE_STORAGE_KEY,
  CODE_CUSTOM_STORAGE_KEY,
  parseTextSize,
  parseCodeSize,
  parseEnabled,
  clampSize,
} from './text-size';

type TextScaleValue = {
  pt: number;
  /** Ratio against the 17pt default; multiplies base font sizes. */
  factor: number;
  setSize: (next: number) => Promise<void>;
  codeSize: number;
  codeCustom: boolean;
  /** Resolved code/terminal pt: custom size when enabled, otherwise scaled default. */
  codePt: number;
  setCodeCustom: (next: boolean) => Promise<void>;
  setCodeSize: (next: number) => Promise<void>;
};

const TextScaleContext = createContext<TextScaleValue>({
  pt: TEXT_SIZE_DEFAULT,
  factor: 1,
  setSize: async () => undefined,
  codeSize: CODE_SIZE_DEFAULT,
  codeCustom: false,
  codePt: CODE_SIZE_DEFAULT,
  setCodeCustom: async () => undefined,
  setCodeSize: async () => undefined,
});

export function TextScaleProvider({ children }: { children: ReactNode }) {
  const [pt, setPt] = useState(TEXT_SIZE_DEFAULT);
  const [codeSize, setCodeSizeState] = useState(CODE_SIZE_DEFAULT);
  const [codeCustom, setCodeCustomState] = useState(false);
  // Preferences changed before storage loaded; hydration must not overwrite them.
  const userPicked = useRef(new Set<'size' | 'codeSize' | 'codeCustom'>());
  useEffect(() => {
    let live = true;
    void Promise.all([
      AsyncStorage.getItem(TEXT_SIZE_STORAGE_KEY),
      AsyncStorage.getItem(CODE_SIZE_STORAGE_KEY),
      AsyncStorage.getItem(CODE_CUSTOM_STORAGE_KEY),
    ]).then(([savedSize, savedCodeSize, savedCustom]) => {
      if (!live) return;
      if (!userPicked.current.has('size')) setPt(parseTextSize(savedSize));
      if (!userPicked.current.has('codeSize')) setCodeSizeState(parseCodeSize(savedCodeSize));
      if (!userPicked.current.has('codeCustom')) setCodeCustomState(parseEnabled(savedCustom));
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const setSize = useCallback(async (next: number) => {
    userPicked.current.add('size');
    const clamped = clampSize(next, TEXT_SIZE_MIN, TEXT_SIZE_MAX);
    setPt(clamped);
    try {
      await AsyncStorage.setItem(TEXT_SIZE_STORAGE_KEY, String(clamped));
    } catch {
      // Keep the in-memory value; storage stays on best effort.
    }
  }, []);
  const setCodeCustom = useCallback(async (next: boolean) => {
    userPicked.current.add('codeCustom');
    setCodeCustomState(next);
    try {
      await AsyncStorage.setItem(CODE_CUSTOM_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // Keep the in-memory value; storage stays on best effort.
    }
  }, []);
  const setCodeSize = useCallback(async (next: number) => {
    userPicked.current.add('codeSize');
    const clamped = clampSize(next, CODE_SIZE_MIN, CODE_SIZE_MAX);
    setCodeSizeState(clamped);
    try {
      await AsyncStorage.setItem(CODE_SIZE_STORAGE_KEY, String(clamped));
    } catch {
      // Keep the in-memory value; storage stays on best effort.
    }
  }, []);
  const codePt = codeCustom ? codeSize : Math.round(CODE_SIZE_DEFAULT * (pt / TEXT_SIZE_DEFAULT));
  const value = useMemo(
    () => ({ pt, factor: pt / TEXT_SIZE_DEFAULT, setSize, codeSize, codeCustom, codePt, setCodeCustom, setCodeSize }),
    [pt, setSize, codeSize, codeCustom, codePt, setCodeCustom, setCodeSize],
  );
  // Theme state piggybacks here because _layout.tsx only mounts this provider.
  return <TextScaleContext.Provider value={value}><RelayThemeProvider>{children}</RelayThemeProvider></TextScaleContext.Provider>;
}

export function useTextScale(): TextScaleValue {
  return useContext(TextScaleContext);
}

type ThemeValue = {
  id: ThemeId;
  colors: typeof relayColors;
  setTheme: (next: ThemeId) => Promise<void>;
};

const ThemeStateContext = createContext<ThemeValue>({ id: 'code', colors: relayColors, setTheme: async () => undefined });

export function RelayThemeProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<ThemeId>('code');
  const userPicked = useRef(false);
  useEffect(() => {
    let live = true;
    void AsyncStorage.getItem(THEME_STORAGE_KEY).then((saved) => {
      if (live && !userPicked.current) setId(parseTheme(saved));
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const setTheme = useCallback(async (next: ThemeId) => {
    userPicked.current = true;
    setId(next);
    try {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Keep the in-memory value; storage stays on best effort.
    }
  }, []);
  const colors = THEME_PALETTES[id];
  const value = useMemo(() => ({ id, colors, setTheme }), [id, colors, setTheme]);
  return <ThemeStateContext.Provider value={value}>{children}</ThemeStateContext.Provider>;
}

export function useRelayTheme(): ThemeValue {
  return useContext(ThemeStateContext);
}

/** Resolved color set for the active theme. */
export function useColors(): typeof relayColors {
  return useContext(ThemeStateContext).colors;
}

/**
 * Minimal draggable slider (core Slider left react-native). Rounded bar with an
 * accent fill and a 28pt knob; steps are whole points between min and max.
 */
export function RelaySlider({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange: (next: number) => void }) {
  const styles = useThemedStyles(createStyles);
  const [trackWidth, setTrackWidth] = useState(0);
  const cyan = useColors().cyan;
  const ratio = (value - min) / (max - min);
  const percent: `${number}%` = `${Math.round(ratio * 100)}%`;
  const moveTo = (x: number) => {
    if (!trackWidth) return;
    const clamped = Math.min(1, Math.max(0, x / trackWidth));
    onChange(Math.round(min + clamped * (max - min)));
  };
  // Created fresh each render so handlers see current props.
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => moveTo(event.nativeEvent.locationX),
    onPanResponderMove: (event) => moveTo(event.nativeEvent.locationX),
  });
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: `${value} pt` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        const next = event.nativeEvent.actionName === 'increment' ? value + 1 : value - 1;
        if (next >= min && next <= max) void onChange(next);
      }}
      onLayout={(layout) => setTrackWidth(layout.nativeEvent.layout.width)}
      {...responder.panHandlers}
      style={styles.slider}
    >
      <View pointerEvents="none" style={styles.sliderTrack}>
        <View style={[styles.sliderFill, { width: percent, backgroundColor: cyan }]} />
      </View>
      <View pointerEvents="none" style={[styles.sliderKnob, { left: percent }]} />
    </View>
  );
}

type ButtonTone = 'default' | 'route' | 'primary' | 'amber' | 'destructive';

export function RelayButton({
  children,
  tone = 'default',
  compact = false,
  ...props
}: ComponentProps<typeof Pressable> & { children: ReactNode; tone?: ButtonTone; compact?: boolean }) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const color = props.disabled ? colors.muted : tone === 'route' || tone === 'primary' ? colors.background : tone === 'amber' ? colors.amber : tone === 'destructive' ? colors.red : colors.primary;
  const backgroundColor = props.disabled
    ? colors.elevated
    : tone === 'route' || tone === 'primary'
      ? colors.primary
      : tone === 'amber'
        ? colors.warningSurface
        : tone === 'destructive'
          ? colors.dangerSurface
          : colors.surface;
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
  gearshape: 'settings',
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
  gearshape: '⚙',
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
  const styles = useThemedStyles(createStyles);
  const iconSize = Math.min(22, Math.max(16, size * 0.5));
  const materialName = androidSymbols[name];
  const colors = useColors();
  const tintColor = tone === 'destructive' ? colors.red : tone === 'primary' ? colors.background : colors.primary;
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
  const styles = useThemedStyles(createStyles);
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
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const color = state === 'connected' ? colors.green : state === 'connecting' ? colors.amber : state === 'revoked' ? colors.red : colors.muted;
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
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
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
    <Text numberOfLines={1} style={[styles.connectionText, { color: state === 'revoked' ? colors.red : colors.amber }]}>{label}</Text>
  </Pressable>;
}

export function Hairline() {
  const styles = useThemedStyles(createStyles);
  return <View style={styles.hairline} />;
}

export function SectionLabel({ children, detail }: { children: string; detail?: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.sectionLabel}>
      <Text style={styles.sectionLabelText}>{children}</Text>
      {detail ? <Text style={styles.sectionLabelDetail}>{detail}</Text> : null}
    </View>
  );
}

export function RelayInput(props: ComponentProps<typeof TextInput>) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  return <TextInput {...props} placeholderTextColor={colors.muted} selectionColor={colors.cyan} style={[styles.input, props.style]} />;
}

export function StatusGlyph({ kind }: { kind: RunEventKind }) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const config: Record<RunEventKind, { glyph: string; color: string }> = {
    user: { glyph: '→', color: colors.cyan },
    assistant: { glyph: '◆', color: colors.primary },
    tool: { glyph: '↳', color: colors.amber },
    system: { glyph: '·', color: colors.muted },
    error: { glyph: '×', color: colors.red },
  };
  const item = config[kind];
  return <Text style={[styles.statusGlyph, { color: item.color }]} accessibilityLabel={`${kind} event`}>{item.glyph}</Text>;
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, paddingHorizontal: relaySpacing.page, paddingBottom: 28 },
  header: { backgroundColor: colors.chrome, minHeight: 62, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, gap: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerLead: { flexDirection: 'row', alignItems: 'center', gap: relaySpacing.compact, flex: 1 },
  title: { color: colors.primary, ...relayTypography.title, letterSpacing: -0.25 },
  headerDetail: { color: colors.secondary, ...relayTypography.caption, marginTop: 2 },
  iconButton: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  iconButtonPrimary: { backgroundColor: colors.primary },
  iconButtonDestructive: { backgroundColor: colors.dangerSurface },
  iconButtonSelected: { borderWidth: 1, borderColor: colors.primary },
  iconFallback: { color: colors.primary, lineHeight: 22, textAlign: 'center' },
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  buttonCompact: { minHeight: 44, paddingHorizontal: 13, borderRadius: 10 },
  buttonText: { fontSize: 15, fontWeight: '600', letterSpacing: 0.1 },
  connectionMark: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  connectionDot: { width: 7, height: 7, borderRadius: 4 },
  connectionAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4, flexShrink: 1 },
  connectionText: { fontSize: 12, fontWeight: '600' },
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  sectionLabel: { paddingTop: 24, paddingBottom: 9, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sectionLabelText: { color: colors.secondary, fontSize: 12, fontWeight: '600', letterSpacing: 0.4 },
  sectionLabelDetail: { color: colors.muted, fontSize: 11 },
  input: { minHeight: 48, borderRadius: 12, color: colors.primary, backgroundColor: colors.surface, paddingHorizontal: 13, paddingVertical: 10, fontSize: 16 },
  statusGlyph: { width: 24, fontSize: 17, lineHeight: 22, fontWeight: '600', textAlign: 'center' },
  slider: { height: 44, justifyContent: 'center' },
  sliderTrack: { alignSelf: 'stretch', height: 4, borderRadius: 2, backgroundColor: colors.lineStrong },
  sliderFill: { height: 4, borderRadius: 2, backgroundColor: colors.cyan },
  sliderKnob: { position: 'absolute', top: (44 - 4) / 2 - 14 + 2, width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primary, transform: [{ translateX: -14 }] },
});

/** Memoize a style factory against the active palette. */
export function useThemedStyles<T>(factory: (colors: RelayPalette) => T): T {
  const colors = useColors();
  return useMemo(() => factory(colors), [factory, colors]);
}

export function useRelayStyles() {
  return useThemedStyles(createStyles);
}

export type { RelayPalette } from './theme';
