import { requireNativeView } from 'expo';
import { useEffect, useMemo, useRef, useState, type ComponentType, type Ref } from 'react';
import { Platform, ScrollView, Text, View, type ViewProps } from 'react-native';

import { useColors, useTextScale } from '../relay/relay-ui';
import { CopyButton } from './copy-button';
import { parseUnifiedDiff } from './diff-parser';

type NativeViewRef = { setRowsJson: (rowsJson: string) => Promise<void> };
type RawProps = ViewProps & {
  ref?: Ref<NativeViewRef>;
  appearanceScheme: 'dark';
  themeJson: string;
  styleJson: string;
  rowHeight: number;
  contentWidth: number;
  contentResetKey: string;
};

let RawNativeDiff: ComponentType<RawProps> | null | undefined;

function nativeDiffView(): ComponentType<RawProps> | null {
  if (RawNativeDiff !== undefined) return RawNativeDiff;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return RawNativeDiff = null;
  try {
    return RawNativeDiff = requireNativeView<RawProps>('T3ReviewDiffSurface');
  } catch {
    console.warn('[native-diff] Native view is unavailable. Using text fallback.');
    return RawNativeDiff = null;
  }
}

export function NativeDiff({ patch }: { patch: string }) {
  const colors = useColors();
  const { codePt } = useTextScale();
  const ref = useRef<NativeViewRef>(null);
  const rows = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const rowsJson = useMemo(() => JSON.stringify(rows), [rows]);
  const [bridgeFailed, setBridgeFailed] = useState(false);
  const NativeView = NativeReviewDiffView;

  useEffect(() => {
    if (!NativeView) return;
    let cancelled = false;
    let frame = 0;
    let attempts = 0;
    const fail = () => {
      if (cancelled) return;
      console.warn('[native-diff] Native view did not accept rows. Using text fallback.');
      setBridgeFailed(true);
    };
    const send = () => {
      if (cancelled) return;
      if (!ref.current) {
        if (attempts++ < 60) frame = requestAnimationFrame(send);
        else fail();
        return;
      }
      void ref.current?.setRowsJson(rowsJson).catch(() => {
        if (attempts++ < 60) frame = requestAnimationFrame(send);
        else fail();
      });
    };
    frame = requestAnimationFrame(send);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [NativeView, rowsJson]);

  if (!NativeView) return null;
  const theme = {
    background: colors.codeBackground, text: colors.codeText, mutedText: colors.muted,
    headerBackground: colors.codeBackground, border: colors.line, hunkBackground: colors.elevated,
    hunkText: colors.primary, addBackground: colors.diffInsert, deleteBackground: colors.diffDelete,
    addBar: colors.green, deleteBar: colors.red, addText: colors.green, deleteText: colors.red,
  };
  const rowHeight = Math.max(22, codePt + 10);
  const height = Math.min(440, Math.max(96, rows.length * rowHeight + 58));
  return <View style={{ marginBottom: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 8, overflow: 'hidden', backgroundColor: colors.codeBackground }}>
    <View style={{ height: 40, paddingLeft: 12, paddingRight: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: colors.line }}>
      <Text style={{ color: colors.muted, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11 }}>Diff</Text>
      <CopyButton text={patch} label="Copy diff" />
    </View>
    {bridgeFailed ? <ScrollView horizontal style={{ maxHeight: height }} contentContainerStyle={{ padding: 12 }}><Text selectable style={{ color: colors.codeText, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: codePt, lineHeight: codePt + 6 }}>{patch}</Text></ScrollView> : <NativeView
      ref={ref}
      style={{ height }}
      appearanceScheme="dark"
      themeJson={JSON.stringify(theme)}
      styleJson={JSON.stringify({ rowHeight, codeFontSize: codePt, lineNumberFontSize: 10, gutterWidth: 44, codePadding: 10, textVerticalInset: 3, fileHeaderHeight: 46, fileHeaderVerticalMargin: 0, fileHeaderHorizontalMargin: 0, fileHeaderCornerRadius: 0 })}
      rowHeight={rowHeight}
      contentWidth={1600}
      contentResetKey={rowsJson}
    />}
  </View>;
}

export function hasNativeDiff(): boolean {
  return NativeReviewDiffView !== null;
}

const NativeReviewDiffView = nativeDiffView();
