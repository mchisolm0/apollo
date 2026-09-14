import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import type { AgentRecord, AgentRuntimeState } from '@/lib/types';
import { ConnectionMark, connectionLabels, relayColors as colors, useTextScale } from './relay-ui';

type Props = {
  agents: readonly AgentRecord[];
  selected: AgentRecord;
  runtime: Readonly<Record<string, AgentRuntimeState>>;
  onSelect: (id: string) => void;
  onDetails: (id: string) => void;
  onPair: () => void;
};
type Anchor = { x: number; y: number; width: number; height: number };

// Match Scryve's SelectField: a short spring and a small expansion from the trigger.
const OPEN_SPRING = { damping: 18, stiffness: 260, mass: 0.6 };

/** An anchored picker that leaves the inbox mounted and closes before navigating. */
export function AgentPicker({ agents, selected, runtime, onSelect, onDetails, onPair }: Props) {
  const trigger = useRef<View>(null);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const closing = useRef(false);
  const [anchor, setAnchor] = useState<Anchor>();
  const { width, height, fontScale } = useWindowDimensions();
  const { factor } = useTextScale();
  const insets = useSafeAreaInsets();
  const progress = useSharedValue(0);
  const [reducedMotion, setReducedMotion] = useState(true);
  const status = runtime[selected.id]?.status ?? 'offline';
  const connection = status === 'idle' ? 'offline' : status;

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReducedMotion(value); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
    return () => { active = false; subscription.remove(); };
  }, []);

  function completeAction() {
    const action = afterClose.current;
    afterClose.current = undefined;
    action?.();
  }

  function finishClose() {
    setAnchor(undefined);
    if (Platform.OS !== 'ios') completeAction();
  }

  function close(action?: () => void) {
    if (closing.current) return;
    closing.current = true;
    afterClose.current = action;
    progress.set(withTiming(0, { duration: reducedMotion ? 0 : 130 }, (finished) => {
      if (finished) scheduleOnRN(finishClose);
    }));
  }

  function show() {
    Keyboard.dismiss();
    trigger.current?.measureInWindow((x, y, triggerWidth, triggerHeight) => {
      closing.current = false;
      progress.set(0);
      setAnchor({ x, y, width: triggerWidth, height: triggerHeight });
    });
  }

  const menuAnimation = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [
      { translateY: reducedMotion ? 0 : -6 * (1 - progress.get()) },
      { scaleY: reducedMotion ? 1 : 0.94 + 0.06 * progress.get() },
    ],
  }));
  const backdropAnimation = useAnimatedStyle(() => ({ opacity: progress.get() * 0.25 }));
  const caretAnimation = useAnimatedStyle(() => ({ transform: [{ rotate: `${progress.get() * 180}deg` }] }));
  const menuWidth = Math.min(Math.max(316, (anchor?.width ?? 0), 280 * fontScale), width - insets.left - insets.right - 24);
  const left = Math.max(insets.left + 12, Math.min(anchor?.x ?? 12, width - insets.right - menuWidth - 12));
  const top = Math.max(insets.top, Math.min((anchor?.y ?? insets.top) + (anchor?.height ?? 44) + 6, height - insets.bottom - 100));

  return <>
    <Pressable
      key={fontScale}
      ref={trigger}
      accessibilityRole="button"
      accessibilityLabel={`Choose agent, ${selected.label}, ${connectionLabels[connection]}`}
      accessibilityHint="Opens available agents and their details"
      accessibilityState={{ expanded: Boolean(anchor) }}
      onPress={show}
      style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
    >
      <View accessible={false} importantForAccessibility="no-hide-descendants"><ConnectionMark state={connection} /></View>
      <Text style={[styles.name, { fontSize: 15 * factor }]} numberOfLines={1}>{selected.label}</Text>
      <Animated.View style={caretAnimation}><SymbolView name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }} size={12} tintColor={colors.primary} /></Animated.View>
    </Pressable>
    <Modal
      transparent
      visible={Boolean(anchor)}
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      supportedOrientations={['portrait', 'landscape']}
      onShow={() => { progress.set(reducedMotion ? 1 : withSpring(1, OPEN_SPRING)); }}
      onRequestClose={() => close()}
      onDismiss={completeAction}
    >
      <View style={styles.modal} accessibilityViewIsModal onAccessibilityEscape={() => close()}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backdrop, backdropAnimation]} />
      <Pressable accessibilityRole="button" accessibilityLabel="Close agent picker" style={StyleSheet.absoluteFill} onPress={() => close()} />
      <Animated.View
        style={[styles.menu, { left, top, width: menuWidth, maxHeight: Math.max(44, height - insets.bottom - top - 12) }, menuAnimation]}
      >
        <ScrollView bounces={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.menuContent}>
          {agents.map((agent) => {
            const status = runtime[agent.id]?.status ?? 'offline';
            const state = status === 'idle' ? 'offline' : status;
            const isSelected = agent.id === selected.id;
            return <View key={agent.id} style={styles.row}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Use ${agent.label}, ${connectionLabels[state]}`}
                accessibilityState={{ selected: isSelected }}
                onPress={() => close(isSelected ? undefined : () => onSelect(agent.id))}
                style={({ pressed }) => [styles.option, pressed && styles.pressed]}
              >
                <View accessible={false} importantForAccessibility="no-hide-descendants"><ConnectionMark state={state} /></View>
                <View style={styles.optionCopy}>
                  <Text style={[styles.optionName, { fontSize: 15 * factor }]}>{agent.label}</Text>
                  {state !== 'connected' ? <Text style={[styles.optionStatus, { fontSize: 12 * factor }]}>{connectionLabels[state]}</Text> : null}
                </View>
                {isSelected ? <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={16} tintColor={colors.primary} /> : null}
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`About ${agent.label}`} onPress={() => close(() => onDetails(agent.id))} style={({ pressed }) => [styles.info, pressed && styles.pressed]}>
                <SymbolView name={{ ios: 'info.circle', android: 'info', web: 'info' }} size={21} tintColor={colors.primary} />
              </Pressable>
            </View>;
          })}
          <Pressable accessibilityRole="button" accessibilityLabel="Pair agent" onPress={() => close(onPair)} style={({ pressed }) => [styles.pair, pressed && styles.pressed]}>
            <SymbolView name={{ ios: 'plus', android: 'add', web: 'add' }} size={17} tintColor={colors.primary} />
            <Text style={[styles.optionName, { fontSize: 15 * factor }]}>Pair agent</Text>
          </Pressable>
        </ScrollView>
      </Animated.View>
      </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  modal: { flex: 1 },
  trigger: { alignSelf: 'flex-start', maxWidth: '100%', flexShrink: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  name: { color: colors.primary, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  backdrop: { backgroundColor: '#000' },
  menu: { position: 'absolute', backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, borderRadius: 12, overflow: 'hidden', transformOrigin: 'top left', boxShadow: '0 12px 32px rgba(0, 0, 0, 0.4)' },
  menuContent: { padding: 4 },
  row: { flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  option: { flex: 1, minWidth: 0, minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 8 },
  optionCopy: { flex: 1, gap: 4 },
  optionName: { color: colors.primary, fontSize: 15, fontWeight: '500', flexShrink: 1 },
  optionStatus: { color: colors.secondary, fontSize: 12 },
  info: { width: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 8 },
  pair: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 8 },
  pressed: { backgroundColor: colors.surface },
});
