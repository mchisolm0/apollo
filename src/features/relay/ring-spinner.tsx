import { useEffect } from 'react';
import Animated, { cancelAnimation, Easing, useAnimatedProps, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// CSS ease-in-out, applied per keyframe segment like the original.
const easeInOut = Easing.bezierFn(0.42, 0, 0.58, 1);
const GAP = 150;

/**
 * An arc that spins while growing and shrinking, ported from svg-spinners'
 * "ring-resize". Reduce Motion shows a still arc.
 */
export function RingSpinner({ size = 14, color }: { size?: number; color: string }) {
  const reduceMotion = useReducedMotion();
  const turn = useSharedValue(0);
  const cycle = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return;
    turn.value = withRepeat(withTiming(1, { duration: 2000, easing: Easing.linear }), -1);
    cycle.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.linear }), -1);
    return () => {
      cancelAnimation(turn);
      cancelAnimation(cycle);
    };
  }, [reduceMotion, turn, cycle]);

  const rotation = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  // Keyframes: 0% dash 0 offset 0, 47.5% dash 42 offset -16, 95-100% dash 42 offset -59.
  const arc = useAnimatedProps(() => {
    if (reduceMotion) return { strokeDasharray: [42, GAP], strokeDashoffset: -16 };
    const t = cycle.value;
    if (t < 0.475) {
      const eased = easeInOut(t / 0.475);
      return { strokeDasharray: [42 * eased, GAP], strokeDashoffset: -16 * eased };
    }
    const eased = easeInOut(Math.min(1, (t - 0.475) / 0.475));
    return { strokeDasharray: [42, GAP], strokeDashoffset: -16 - 43 * eased };
  });

  return <Animated.View style={[{ width: size, height: size }, rotation]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <AnimatedCircle cx={12} cy={12} r={9.5} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" animatedProps={arc} />
    </Svg>
  </Animated.View>;
}
