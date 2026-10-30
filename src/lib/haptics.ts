import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { streamTick, type StreamTickState } from './stream-tick.ts';

// iOS skips these when system haptics are off. Web has no haptics, so they no-op there.
const run = (feedback: () => Promise<void>) => { if (Platform.OS !== 'web') feedback().catch(() => {}); };

export const haptics = {
  /** The lightest tick, for streaming text and picks. */
  selection: () => run(Haptics.selectionAsync),
  /** A light tap, for copy. */
  light: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** A firmer tap, for a swipe that commits. */
  medium: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
};

/** Ticks lightly while `streaming` (the reply currently streaming in) grows, throttled by `streamTick`. */
export function useStreamTick(streaming: { readonly id: string; readonly length: number } | undefined) {
  const last = useRef<StreamTickState | undefined>(undefined);
  const id = streaming?.id;
  const length = streaming?.length ?? 0;
  useEffect(() => {
    const next = streamTick(last.current, id === undefined ? undefined : { id, length }, Date.now());
    last.current = next.state;
    if (next.tick) haptics.selection();
  }, [id, length]);
}
