import { SymbolView } from "expo-symbols";
import { memo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Animated, {
  Easing,
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  withTiming,
  type EntryExitAnimationFunction,
  type SharedValue,
} from "react-native-reanimated";

import { useColors, useThemedStyles, type RelayPalette } from "../relay/relay-ui";
import type { VoiceInputPhase, VoiceInputState } from "./controller";
import type { VoiceComposerPresentation } from "./voiceInputPresentation";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const DICTATION_TIMING = {
  duration: 220,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const TOOLBAR_FLIP_TIMING = {
  duration: 260,
  easing: Easing.inOut(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const TOOLBAR_HALF_HEIGHT = 22;
const TOOLBAR_PERSPECTIVE = 600;

function toolbarFlip(fromDegrees: number, toDegrees: number): EntryExitAnimationFunction {
  return () => {
    "worklet";
    const fromRadians = (fromDegrees * Math.PI) / 180;
    const toRadians = (toDegrees * Math.PI) / 180;
    const fromSine = Math.sin(fromRadians);
    const toSine = Math.sin(toRadians);
    return {
      initialValues: {
        opacity: fromDegrees === 0 ? 1 : 0,
        transform: [
          { perspective: TOOLBAR_PERSPECTIVE },
          { translateY: -TOOLBAR_HALF_HEIGHT * fromSine },
          { rotateX: `${fromDegrees}deg` },
        ],
      },
      animations: {
        opacity: withTiming(toDegrees === 0 ? 1 : 0, TOOLBAR_FLIP_TIMING),
        transform: [
          { perspective: TOOLBAR_PERSPECTIVE },
          {
            translateY: withTiming(-TOOLBAR_HALF_HEIGHT * toSine, {
              ...TOOLBAR_FLIP_TIMING,
              easing: (time) => {
                const angle =
                  fromRadians + (toRadians - fromRadians) * TOOLBAR_FLIP_TIMING.easing(time);
                return (Math.sin(angle) - fromSine) / (toSine - fromSine);
              },
            }),
          },
          { rotateX: withTiming(`${toDegrees}deg`, TOOLBAR_FLIP_TIMING) },
        ],
      },
    };
  };
}

const DRAFT_TOOLBAR_ENTERING = toolbarFlip(90, 0);
const DRAFT_TOOLBAR_EXITING = toolbarFlip(0, 90);
const DICTATION_TOOLBAR_ENTERING = toolbarFlip(-90, 0);
const DICTATION_TOOLBAR_EXITING = toolbarFlip(0, -90);
const WAVEFORM_BAR_HEIGHT = 32;
const WAVEFORM_MIN_BAR_HEIGHT = 2;
const WAVEFORM_BAR_SPACING = 5;
const WAVEFORM_TIMING = {
  duration: 100,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.System,
} as const;

/** Flips between the draft toolbar (children) and the dictation toolbar. */
export function ComposerDictationToolbar(props: {
  readonly children: ReactNode;
  readonly dictation: ReactNode;
  readonly showsDictation: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const entering = props.showsDictation ? DICTATION_TOOLBAR_ENTERING : DRAFT_TOOLBAR_ENTERING;
  const exiting = props.showsDictation ? DICTATION_TOOLBAR_EXITING : DRAFT_TOOLBAR_EXITING;

  return (
    // The draft toolbar appears without a flip when the composer expands.
    <View style={styles.toolbar}>
      <LayoutAnimationConfig skipEntering>
        <Animated.View
          key={props.showsDictation ? "dictation" : "draft"}
          entering={reducedMotion ? undefined : entering}
          exiting={reducedMotion ? undefined : exiting}
          style={styles.toolbarFace}
        >
          {props.showsDictation ? props.dictation : props.children}
        </Animated.View>
      </LayoutAnimationConfig>
    </View>
  );
}

const WaveformBar = memo(function WaveformBar(props: {
  readonly audioLevels: SharedValue<readonly number[]>;
  readonly sampleIndex: number;
  readonly color: string;
}) {
  const { audioLevels, sampleIndex } = props;
  const height = WAVEFORM_BAR_HEIGHT;
  const animatedStyle = useAnimatedStyle(() => {
    const level = audioLevels.value[sampleIndex] ?? 0;
    return {
      opacity: withTiming(0.22 + level * 0.78, WAVEFORM_TIMING),
      transform: [
        {
          scaleY: withTiming(
            (WAVEFORM_MIN_BAR_HEIGHT + level * (height - WAVEFORM_MIN_BAR_HEIGHT)) / height,
            WAVEFORM_TIMING,
          ),
        },
      ],
    };
  });

  return (
    <Animated.View
      style={[{ width: 2, height, borderRadius: 1, backgroundColor: props.color }, animatedStyle]}
    />
  );
});

const VoiceWaveform = memo(function VoiceWaveform(props: {
  readonly audioLevels: SharedValue<readonly number[]>;
}) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const [barCount, setBarCount] = useState(0);
  const handleLayout = (event: LayoutChangeEvent) => {
    setBarCount(
      Math.max(
        1,
        Math.min(
          VOICE_WAVEFORM_SAMPLE_COUNT,
          Math.floor(event.nativeEvent.layout.width / WAVEFORM_BAR_SPACING),
        ),
      ),
    );
  };

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.waveform}
      onLayout={handleLayout}
    >
      {Array.from({ length: barCount }, (_, index) => (
        <WaveformBar
          key={index}
          audioLevels={props.audioLevels}
          color={colors.primary}
          sampleIndex={VOICE_WAVEFORM_SAMPLE_COUNT - barCount + index}
        />
      ))}
    </View>
  );
});

/** Tabular figures keep the timer from jittering. */
export function DictationElapsedTime(props: { readonly seconds: number }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Text numberOfLines={1} style={styles.elapsed}>
      {Math.floor(props.seconds / 60)}:{String(props.seconds % 60).padStart(2, "0")}
    </Text>
  );
}

const VOICE_ICONS = {
  mic: { ios: "mic", android: "mic", web: "mic" },
  xmark: { ios: "xmark", android: "close", web: "close" },
  checkmark: { ios: "checkmark", android: "check", web: "check" },
} as const;

function VoiceActionButton(props: {
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly icon: keyof typeof VOICE_ICONS;
  readonly loading?: boolean;
  readonly onPress: () => void;
  readonly variant?: "plain" | "primary";
  /** Primary circle diameter, matching the composer's send button. */
  readonly size?: number;
}) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const primary = props.variant === "primary";
  const loading = props.loading === true;
  const size = props.size ?? 32;
  const primaryStyle = useAnimatedStyle(() => ({
    opacity: withTiming(loading ? 0 : 1, DICTATION_TIMING),
  }));

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: props.loading, disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={primary ? Math.max(0, (44 - size) / 2) : undefined}
      onPress={props.onPress}
      style={({ pressed }) => [
        primary
          ? [styles.primaryAction, { width: size, height: size, borderRadius: size / 2 }]
          : styles.plainAction,
        { opacity: props.disabled && !loading ? 0.4 : pressed ? 0.7 : 1 },
      ]}
    >
      {primary ? (
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.primaryFill, { borderRadius: size / 2 }, primaryStyle]}
        />
      ) : null}
      {loading ? (
        <ActivityIndicator size="small" color={colors.secondary} />
      ) : (
        <SymbolView
          name={VOICE_ICONS[props.icon]}
          size={primary ? 16 : 20}
          weight={primary ? "semibold" : "regular"}
          tintColor={primary ? colors.background : colors.secondary}
        />
      )}
    </Pressable>
  );
}

export function ComposerDictationStatus(props: {
  readonly audioLevels: SharedValue<readonly number[]>;
  readonly elapsedSeconds: number;
  readonly phase: VoiceInputPhase;
  readonly presentation: VoiceComposerPresentation;
  readonly onDismissError: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const recording = props.phase === "recording";
  const waveformStyle = useAnimatedStyle(() => ({
    opacity: withTiming(recording ? 1 : 0, DICTATION_TIMING),
  }));
  const labelStyle = useAnimatedStyle(() => ({
    opacity: withTiming(recording ? 0 : 1, DICTATION_TIMING),
  }));

  if (!props.presentation.statusLabel) return null;
  const isError = props.presentation.statusKind === "error";
  return (
    <View style={styles.status}>
      {isError ? (
        <View style={styles.errorRow}>
          <Text style={styles.errorText} numberOfLines={2}>
            {props.presentation.statusLabel}
          </Text>
          <Pressable
            accessibilityLabel="Dismiss voice input error"
            accessibilityRole="button"
            hitSlop={8}
            onPress={props.onDismissError}
            style={({ pressed }) => [styles.dismiss, { opacity: pressed ? 0.7 : 1 }]}
          >
            <SymbolView
              name={{ ios: "xmark", android: "close", web: "close" }}
              size={12}
              tintColor={colors.muted}
            />
          </Pressable>
        </View>
      ) : (
        <View
          accessible
          accessibilityLabel={props.presentation.statusLabel}
          accessibilityLiveRegion={recording ? "none" : "polite"}
          style={styles.statusFace}
        >
          <Animated.View style={[StyleSheet.absoluteFill, styles.recordingRow, waveformStyle]}>
            <VoiceWaveform audioLevels={props.audioLevels} />
            <DictationElapsedTime seconds={props.elapsedSeconds} />
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, styles.labelRow, labelStyle]}>
            <Text style={styles.label} numberOfLines={1}>
              {props.presentation.statusLabel}
            </Text>
          </Animated.View>
        </View>
      )}
    </View>
  );
}

export function ComposerDictationCancelAction(props: {
  readonly presentation: VoiceComposerPresentation;
  readonly onCancel: () => void;
}) {
  if (props.presentation.leadingAction !== "cancel") return null;
  return (
    <VoiceActionButton accessibilityLabel="Cancel dictation" icon="xmark" onPress={props.onCancel} />
  );
}

export function ComposerDictationPrimaryAction(props: {
  readonly state: VoiceInputState;
  readonly presentation: VoiceComposerPresentation;
  readonly isAvailable: boolean;
  readonly disabled?: boolean;
  readonly size?: number;
  readonly onStart: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  if (props.presentation.trailingAction === "confirm") {
    return (
      <VoiceActionButton
        size={props.size}
        accessibilityLabel={
          props.presentation.confirmationEnabled
            ? "Finish dictation"
            : (props.presentation.statusLabel ?? "Preparing voice input")
        }
        disabled={!props.presentation.confirmationEnabled}
        icon="checkmark"
        loading={!props.presentation.confirmationEnabled}
        onPress={props.onConfirm}
        variant="primary"
      />
    );
  }

  return <ComposerDictationStartAction {...props} />;
}

export function ComposerDictationStartAction(props: {
  readonly state: VoiceInputState;
  readonly isAvailable: boolean;
  readonly disabled?: boolean;
  readonly onStart: () => void;
  readonly onCancel: () => void;
}) {
  if (!props.isAvailable) return null;
  const openSettings = props.state.phase === "error" && props.state.errorAction === "settings";
  return (
    <VoiceActionButton
      accessibilityLabel={openSettings ? "Open microphone settings" : "Start dictation"}
      disabled={props.disabled}
      icon="mic"
      onPress={
        openSettings
          ? () => {
              props.onCancel();
              void Linking.openSettings();
            }
          : props.onStart
      }
    />
  );
}

const createStyles = (colors: RelayPalette) =>
  StyleSheet.create({
    toolbar: { height: 44, overflow: "hidden" },
    toolbarFace: { ...StyleSheet.absoluteFill, backfaceVisibility: "hidden" },
    waveform: {
      flex: 1,
      minWidth: 0,
      height: WAVEFORM_BAR_HEIGHT,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      overflow: "hidden",
    },
    elapsed: { color: colors.secondary, fontSize: 12, fontVariant: ["tabular-nums"] },
    plainAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    primaryAction: {
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.lineStrong,
    },
    primaryFill: { backgroundColor: colors.primary },
    status: { flex: 1, minWidth: 0, height: 44, justifyContent: "center" },
    statusFace: { height: 44 },
    errorRow: {
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
    },
    errorText: { flex: 1, minWidth: 0, color: colors.red, fontSize: 14 },
    dismiss: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
    recordingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 },
    labelRow: { justifyContent: "center", paddingHorizontal: 8 },
    label: { color: colors.secondary, fontSize: 14, textAlign: "center" },
  });
