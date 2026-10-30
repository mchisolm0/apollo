import { requireNativeView, requireOptionalNativeModule } from 'expo';
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ComponentType, type Ref } from 'react';
import { Platform, TextInput, type NativeSyntheticEvent, type StyleProp, type TextInputInstance, type ViewProps, type ViewStyle } from 'react-native';

import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
  type ComposerNativeEventSnapshot,
} from './src/revision.ts';

export type ComposerSelection = { readonly start: number; readonly end: number };

/** A span of `value` drawn as one atomic chip. The draft keeps `source`; the chip shows `label`. */
export type ComposerToken = { readonly type: 'skill'; readonly source: string; readonly label: string; readonly start: number; readonly end: number };

/** Hardware Return: `send` submits and Shift-Return adds a line; `newline` adds a line. Command-Return always submits. */
export type ComposerEnterBehavior = 'send' | 'newline';

/** A text paste the editor held back because it is long. `value` and `selection` are the draft it would land in. */
export type ComposerTextPaste = { readonly value: string; readonly text: string; readonly selection: ComposerSelection };

/** Opaque hex colors. Chips blend `accent` over `surface`. */
export type ComposerTheme = { readonly text: string; readonly placeholder: string; readonly accent: string; readonly surface: string };

export type ComposerEditorHandle = { focus: () => void; blur: () => void };

export type ComposerEditorProps = {
  readonly ref?: Ref<ComposerEditorHandle>;
  readonly value: string;
  /** Applied once when it changes; the editor reports its own selection through `onSelectionChange`. */
  readonly selection?: ComposerSelection;
  readonly tokens?: readonly ComposerToken[];
  readonly theme: ComposerTheme;
  readonly placeholder?: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly contentInsetVertical?: number;
  /** The editor grows with its content between these heights. */
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly editable?: boolean;
  /** Blocks edits but keeps focus, selection, and the keyboard. */
  readonly readOnly?: boolean;
  readonly scrollEnabled?: boolean;
  readonly autoFocus?: boolean;
  readonly enterBehavior?: ComposerEnterBehavior;
  readonly maxLength: number;
  /** Text pastes this many UTF-16 characters long, or that would pass `maxLength`, go to `onPasteText` instead of the draft. */
  readonly textPasteThresholdChars?: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly onChangeText: (value: string) => void;
  /** `text` is the editor's text at that selection, which can be ahead of `value`. */
  readonly onSelectionChange?: (selection: ComposerSelection, text: string) => void;
  readonly onPasteImages?: (uris: readonly string[]) => void;
  readonly onPasteText?: (paste: ComposerTextPaste) => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
  /** Hardware Command-Return, or Return when `enterBehavior` is `send`. */
  readonly onSubmit?: () => void;
};

type NativeEditorEvent = NativeSyntheticEvent<{ readonly value: string; readonly selection: ComposerSelection; readonly eventCount: number }>;
type NativePasteTextEvent = NativeSyntheticEvent<{ readonly value: string; readonly eventCount: number; readonly text: string; readonly selection: ComposerSelection }>;

type NativeComposerEditorRef = {
  focus: () => Promise<void>;
  blur: () => Promise<void>;
};

type NativeComposerEditorProps = ViewProps & {
  readonly ref?: Ref<NativeComposerEditorRef>;
  readonly controlledDocumentJson: string;
  readonly themeJson: string;
  readonly placeholder: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly contentInsetVertical: number;
  readonly editable: boolean;
  readonly readOnly: boolean;
  readonly enterBehavior: ComposerEnterBehavior;
  readonly scrollEnabled: boolean;
  readonly autoFocus: boolean;
  readonly autoCorrect: boolean;
  readonly spellCheck: boolean;
  readonly textPasteThresholdChars: number;
  readonly maxInputChars: number;
  readonly textAccessibilityLabel: string;
  readonly textAccessibilityHint: string;
  readonly onComposerChange: (event: NativeEditorEvent) => void;
  readonly onComposerSelectionChange: (event: NativeEditorEvent) => void;
  readonly onComposerPasteImages: (event: NativeSyntheticEvent<{ readonly uris: readonly string[] }>) => void;
  readonly onComposerPasteText: (event: NativePasteTextEvent) => void;
  readonly onComposerContentSizeChange: (event: NativeSyntheticEvent<{ readonly width: number; readonly height: number }>) => void;
  readonly onComposerFocus?: () => void;
  readonly onComposerBlur?: () => void;
  readonly onComposerSubmit?: () => void;
};

let NativeView: ComponentType<NativeComposerEditorProps> | null | undefined;

/** Null on Android, web, and builds made before this module existed. */
function nativeEditor(): ComponentType<NativeComposerEditorProps> | null {
  if (NativeView !== undefined) return NativeView;
  // requireNativeView does not throw for a missing view, it renders a broken one, so check the module first.
  if (Platform.OS !== 'ios' || !requireOptionalNativeModule('T3ComposerEditor')) return NativeView = null;
  return NativeView = requireNativeView<NativeComposerEditorProps>('T3ComposerEditor');
}

/**
 * T3 Code's UIKit composer on iOS: skill chips, image and long-text paste, and hardware Return.
 * Android and web get a plain TextInput with the same controlled value and selection.
 */
export function ComposerEditor(props: ComposerEditorProps) {
  const Native = nativeEditor();
  return Native ? <NativeComposerEditor {...props} Native={Native} /> : <FallbackComposerEditor {...props} />;
}

function NativeComposerEditor({ Native, ref, value, selection, tokens = [], theme, minHeight, maxHeight, contentInsetVertical = 0, onChangeText, onSelectionChange, onPasteImages, onPasteText, style, ...props }: ComposerEditorProps & { Native: ComponentType<NativeComposerEditorProps> }) {
  const nativeRef = useRef<NativeComposerEditorRef>(null);
  const [contentHeight, setContentHeight] = useState(minHeight);
  // Ported from T3's T3ComposerEditor.ios.tsx. Native events carry a revision counter; a render
  // whose value and selection lag the newest acknowledged native state is stamped behind it, so the
  // editor rejects it instead of re-applying stale text or a stale caret mid-typing.
  const mostRecentEventCountRef = useRef(0);
  const [mostRecentEventCount, setMostRecentEventCount] = useState(0);
  const [, forceNativeEventRender] = useState(0);
  // The editor mounts empty, so the first controlled payload must not count as an echo.
  const nativeEventSnapshotsRef = useRef<ComposerNativeEventSnapshot[]>([]);

  useImperativeHandle(ref, () => ({
    focus: () => void nativeRef.current?.focus(),
    blur: () => void nativeRef.current?.blur(),
  }), []);

  // The snapshot ref is read during render on purpose, exactly as T3 does: it is the native
  // history this render must be stamped against.
  // eslint-disable-next-line react-hooks/refs
  const controlledEventCount = resolveComposerControlledEventCount(value, selection ?? null, mostRecentEventCount, nativeEventSnapshotsRef.current);
  // eslint-disable-next-line react-hooks/refs
  const acknowledgesLatestNativeEvent = isComposerNativeEcho(value, selection ?? null, mostRecentEventCount, nativeEventSnapshotsRef.current);
  const isNativeEcho = controlledEventCount === mostRecentEventCount && acknowledgesLatestNativeEvent;
  const controlledDocumentJson = JSON.stringify({
    value,
    selection: isNativeEcho ? null : (selection ?? null),
    tokensJson: JSON.stringify(tokens),
    mostRecentEventCount: controlledEventCount,
    isNativeEcho,
  });
  useEffect(() => {
    if (!acknowledgesLatestNativeEvent) return;
    nativeEventSnapshotsRef.current = pruneAcknowledgedComposerNativeEvents(nativeEventSnapshotsRef.current, mostRecentEventCount);
  }, [acknowledgesLatestNativeEvent, mostRecentEventCount]);
  useEffect(() => {
    // A native event that arrived after this render committed moves the revision forward; the
    // editor rejects this payload, so the history must not assume it applied.
    if (isNativeEcho || controlledEventCount !== mostRecentEventCountRef.current) return;
    nativeEventSnapshotsRef.current = assumeComposerControlledState(nativeEventSnapshotsRef.current, controlledEventCount, value);
  }, [value, controlledEventCount, isNativeEcho, controlledDocumentJson]);
  const acceptNativeEvent = useCallback((eventCount: number, nextValue: string, nextSelection: ComposerSelection) => {
    const acknowledged = acknowledgeComposerNativeEvent(mostRecentEventCountRef.current, eventCount);
    if (acknowledged === null) return false;
    mostRecentEventCountRef.current = acknowledged;
    nativeEventSnapshotsRef.current.push({ eventCount: acknowledged, value: nextValue, selection: nextSelection });
    return acknowledged;
  }, []);
  const settle = (acknowledged: number) => {
    setMostRecentEventCount(acknowledged);
    forceNativeEventRender((sequence) => sequence + 1);
  };

  return <Native
    ref={nativeRef}
    controlledDocumentJson={controlledDocumentJson}
    themeJson={JSON.stringify(theme)}
    placeholder={props.placeholder ?? ''}
    fontFamily=""
    fontSize={props.fontSize}
    lineHeight={props.lineHeight}
    contentInsetVertical={contentInsetVertical}
    editable={props.editable ?? true}
    readOnly={props.readOnly ?? false}
    enterBehavior={props.enterBehavior ?? 'send'}
    scrollEnabled={props.scrollEnabled ?? true}
    autoFocus={props.autoFocus ?? false}
    autoCorrect
    spellCheck
    textPasteThresholdChars={onPasteText ? (props.textPasteThresholdChars ?? 0) : 0}
    maxInputChars={props.maxLength}
    textAccessibilityLabel={props.accessibilityLabel ?? ''}
    textAccessibilityHint={props.accessibilityHint ?? ''}
    style={[style, { height: Math.min(maxHeight, Math.max(minHeight, contentHeight)) }]}
    onComposerChange={({ nativeEvent }) => {
      const acknowledged = acceptNativeEvent(nativeEvent.eventCount, nativeEvent.value, nativeEvent.selection);
      if (acknowledged === false) return;
      onChangeText(nativeEvent.value);
      onSelectionChange?.(nativeEvent.selection, nativeEvent.value);
      settle(acknowledged);
    }}
    onComposerSelectionChange={({ nativeEvent }) => {
      const acknowledged = acceptNativeEvent(nativeEvent.eventCount, nativeEvent.value, nativeEvent.selection);
      if (acknowledged === false) return;
      // A selection change that raced a text edit can carry post-edit text; the parent needs it
      // with this revision, or the next render stamps the stale draft and re-applies it.
      if (nativeEvent.value !== value) onChangeText(nativeEvent.value);
      onSelectionChange?.(nativeEvent.selection, nativeEvent.value);
      settle(acknowledged);
    }}
    onComposerPasteImages={({ nativeEvent }) => onPasteImages?.(nativeEvent.uris)}
    onComposerPasteText={({ nativeEvent }) => {
      const acknowledged = acceptNativeEvent(nativeEvent.eventCount, nativeEvent.value, nativeEvent.selection);
      if (acknowledged === false) return;
      // Sync the draft before the async paste captures where it lands.
      onChangeText(nativeEvent.value);
      onSelectionChange?.(nativeEvent.selection, nativeEvent.value);
      onPasteText?.({ value: nativeEvent.value, text: nativeEvent.text, selection: nativeEvent.selection });
      settle(acknowledged);
    }}
    onComposerContentSizeChange={({ nativeEvent }) => setContentHeight(Math.ceil(nativeEvent.height))}
    onComposerFocus={props.onFocus}
    onComposerBlur={props.onBlur}
    onComposerSubmit={props.onSubmit}
  />;
}

function FallbackComposerEditor({ ref, value, selection, theme, minHeight, maxHeight, contentInsetVertical = 0, onChangeText, onSelectionChange, style, ...props }: ComposerEditorProps) {
  const input = useRef<TextInputInstance>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), blur: () => input.current?.blur() }), []);
  return <TextInput
    ref={input}
    value={value}
    selection={selection}
    onChangeText={onChangeText}
    onSelectionChange={(event) => onSelectionChange?.(event.nativeEvent.selection, value)}
    multiline
    autoFocus={props.autoFocus}
    editable={(props.editable ?? true) && !props.readOnly}
    scrollEnabled={props.scrollEnabled}
    maxLength={props.maxLength}
    placeholder={props.placeholder}
    placeholderTextColor={theme.placeholder}
    selectionColor={theme.accent}
    accessibilityLabel={props.accessibilityLabel}
    accessibilityHint={props.accessibilityHint}
    onFocus={props.onFocus}
    onBlur={props.onBlur}
    style={[style, { color: theme.text, fontSize: props.fontSize, lineHeight: props.lineHeight, paddingVertical: contentInsetVertical, minHeight, maxHeight, textAlignVertical: 'top' }]}
  />;
}
