import { useFocusEffect } from "expo-router";
import { useCallback, useLayoutEffect, useRef } from "react";

import { voiceInputBlocksSubmission, type VoiceInputState } from "./controller";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

type Selection = { readonly start: number; readonly end: number };

/**
 * One composer's view of the app's voice input. Unlike T3 there is no global
 * pill: a composer that unmounts, loses focus, or whose owner changes, discards
 * its dictation.
 */
export function useVoiceInputController(input: {
  /** Null while the composer is hidden; dictation needs an owner. */
  readonly ownerKey: string | null;
  readonly draftMessage: string;
  readonly selection: Selection;
  readonly disabled?: boolean;
  /** Receives the draft with the transcript inserted and the cursor after it. */
  readonly onCommitDraft: (text: string, selection: Selection) => void;
}) {
  const global = useGlobalVoiceInput();
  const { session } = global;
  const latestInput = useRef(input);
  // Transcription finishes asynchronously and must reach the composer's current draft and setters, not the ones captured at start.
  useLayoutEffect(() => {
    latestInput.current = input;
  });

  // A pushed screen (agent settings) keeps this composer mounted, so blur cancels too.
  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      return () => session.cancel(ownerKey);
    }, [input.ownerKey, session]),
  );

  const start = useCallback(() => {
    const captured = latestInput.current;
    const ownerKey = captured.ownerKey;
    if (!ownerKey || captured.disabled) return;
    const isCurrent = () => latestInput.current.ownerKey === ownerKey;
    void session.start(
      createVoiceInputTarget(
        ownerKey,
        () => (isCurrent() ? latestInput.current.draftMessage : null),
        (text, selection) => {
          if (isCurrent()) latestInput.current.onCommitDraft(text, selection);
        },
        captured.selection,
      ),
    );
  }, [session]);
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  const isBusy = voiceInputBlocksSubmission(state);
  return {
    isAvailable: global.isAvailable && (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    cancel: global.cancel,
  };
}
