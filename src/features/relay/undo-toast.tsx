import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import { GlassView } from 'expo-glass-effect';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HAS_MAIL_TOOLBAR, MAIL_TOOLBAR_INSET } from './mail-toolbar';
import { useColors } from './relay-ui';

/** How long Undo stays offered, matching T3's sidebar notice. */
export const UNDO_TOAST_MS = 5000;

type UndoNotice = { id: number; scope: string; message: string; undo: () => void };

/**
 * One undoable action at a time: a newer action replaces the older notice and its Undo.
 * A notice belongs to the `scope` (agent) it was shown in and hides once the scope changes.
 */
export function useUndoToast(scope: string) {
  const [notice, setNotice] = useState<UndoNotice>();
  const current = useRef<UndoNotice>(undefined);
  const next = useRef(0);
  const replace = useCallback((value: UndoNotice | undefined) => { current.current = value; setNotice(value); }, []);
  useEffect(() => {
    if (!notice) return;
    AccessibilityInfo.announceForAccessibility(`${notice.message}. Undo available.`);
    const timer = setTimeout(() => { if (current.current?.id === notice.id) replace(undefined); }, UNDO_TOAST_MS);
    return () => clearTimeout(timer);
  }, [notice, replace]);
  const show = useCallback((message: string, undo: () => void) => replace({ id: ++next.current, scope, message, undo }), [replace, scope]);
  // Clear before running so a double tap cannot undo twice.
  const undo = useCallback(() => {
    const pending = current.current;
    replace(undefined);
    if (pending?.scope === scope) pending.undo();
  }, [replace, scope]);
  return { notice: notice?.scope === scope ? notice : undefined, show, undo };
}

// Same placement as the "Update ready" notice: just above the bottom dock, over the list.
const DOCK_HEIGHT = HAS_MAIL_TOOLBAR ? MAIL_TOOLBAR_INSET : 60;
const DOCK_MARGIN = HAS_MAIL_TOOLBAR ? 16 : 12;

export function UndoToast({ notice, onUndo }: { notice: UndoNotice | undefined; onUndo: () => void }) {
  const colors = useColors();
  const { bottom } = useSafeAreaInsets();
  if (!notice) return null;
  const content = <>
    <Text numberOfLines={1} style={[styles.text, { color: colors.primary }]}>{notice.message}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`Undo ${notice.message.toLowerCase()}`} onPress={onUndo} style={styles.action}>
      <Text style={[styles.actionText, { color: colors.cyan }]}>Undo</Text>
    </Pressable>
  </>;
  return <Animated.View key={notice.id} entering={FadeInDown.duration(200)} exiting={FadeOutDown.duration(160)} pointerEvents="box-none" style={[styles.layer, { bottom: bottom + DOCK_HEIGHT + 8, left: DOCK_MARGIN, right: DOCK_MARGIN }]}>
    {HAS_MAIL_TOOLBAR
      ? <GlassView glassEffectStyle="regular" accessibilityLiveRegion="polite" style={[styles.toast, styles.glass]}>{content}</GlassView>
      : <View accessibilityLiveRegion="polite" style={[styles.toast, { backgroundColor: colors.surface }]}>{content}</View>}
  </Animated.View>;
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', alignItems: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4, borderRadius: 8, maxWidth: 420, overflow: 'hidden' },
  glass: { borderRadius: 22 },
  text: { flexShrink: 1, fontSize: 15, lineHeight: 21 },
  action: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
  actionText: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
});
