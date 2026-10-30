import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRelayStyles } from './relay-ui';

// Docks clear the home indicator by this much instead of the whole safe area, like iOS 26 system toolbars.
const HOME_INDICATOR_CLEARANCE = 16;

/**
 * Owns the bottom edge: docks rest just above the home indicator and follow the keyboard, tracking it
 * during interactive swipe-down dismiss. Parents skip the bottom safe area.
 * `edgeToEdge` content runs under a native toolbar to the screen edge and pads itself.
 */
export function KeyboardFrame({ edgeToEdge = false, children }: { edgeToEdge?: boolean; children: ReactNode }) {
  const styles = useRelayStyles();
  const { bottom } = useSafeAreaInsets();
  // Negative while the keyboard is up.
  const { height } = useReanimatedKeyboardAnimation();
  const resting = edgeToEdge ? 0 : Platform.OS === 'ios' ? Math.min(bottom, HOME_INDICATOR_CLEARANCE) : bottom;
  const padding = useAnimatedStyle(() => ({ paddingBottom: Math.max(-height.value, resting) }));
  return <Animated.View style={[styles.screen, padding]}>{children}</Animated.View>;
}
