import { useEffect, useState, type ReactNode } from 'react';
import { Keyboard, Platform, useWindowDimensions, View, type KeyboardEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRelayStyles } from './relay-ui';

/** Both screens and native sheets end at the bottom safe area. */
export function KeyboardFrame({ children }: { children: ReactNode }) {
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
  const paddingBottom = Platform.OS === 'ios' && keyboardTop !== undefined
    ? Math.max(0, height - bottom - keyboardTop)
    : 0;
  return <View style={[styles.screen, { paddingBottom }]}>{children}</View>;
}
