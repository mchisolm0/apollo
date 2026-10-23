import { useEffect, useState, type ReactNode } from 'react';
import { Keyboard, Platform, useWindowDimensions, View, type KeyboardEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRelayStyles } from './relay-ui';

// Docks clear the home indicator by this much instead of the whole safe area, like iOS 26 system toolbars.
const HOME_INDICATOR_CLEARANCE = 16;

/**
 * Owns the bottom edge: docks rest just above the home indicator and ride the keyboard. Parents skip the bottom safe area.
 * `edgeToEdge` content runs under a native toolbar to the screen edge and pads itself.
 */
export function KeyboardFrame({ edgeToEdge = false, children }: { edgeToEdge?: boolean; children: ReactNode }) {
  const styles = useRelayStyles();
  const { height } = useWindowDimensions();
  const { bottom } = useSafeAreaInsets();
  const [keyboardTop, setKeyboardTop] = useState(() => Keyboard.metrics()?.screenY);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const move = Keyboard.addListener('keyboardWillChangeFrame', (event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
      setKeyboardTop(event.endCoordinates.screenY);
    });
    const hide = Keyboard.addListener('keyboardWillHide', (event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
      setKeyboardTop(undefined);
    });
    return () => { move.remove(); hide.remove(); };
  }, []);
  const keyboardHeight = keyboardTop === undefined ? 0 : height - keyboardTop;
  const resting = edgeToEdge ? 0 : Platform.OS === 'ios' ? Math.min(bottom, HOME_INDICATOR_CLEARANCE) : bottom;
  const paddingBottom = Math.max(keyboardHeight, resting);
  return <View style={[styles.screen, { paddingBottom }]}>{children}</View>;
}
