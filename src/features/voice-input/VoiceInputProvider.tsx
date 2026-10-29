import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { makeMutable, type SharedValue } from "react-native-reanimated";

import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { voiceInputBlocksSubmission } from "./controller";
import { createLazyVoiceRecorder } from "./lazyVoiceRecorder";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";

// The native constructor expects platform-flattened options, as built by useAudioRecorder.
const { ios: IOS_RECORDING_OPTIONS, android: ANDROID_RECORDING_OPTIONS } =
  RecordingPresets.HIGH_QUALITY;
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  isMeteringEnabled: true,
  ...(Platform.OS === "ios" ? IOS_RECORDING_OPTIONS : ANDROID_RECORDING_OPTIONS),
};

function keepScreenAwake(tag: string): () => void {
  const activation = activateKeepAwakeAsync(tag);
  void activation.catch(() => {});
  // Release after activation settles, even if the recording ends immediately.
  return () => void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
}

type VoiceInput = {
  readonly session: VoiceInputSession;
  readonly audioLevels: SharedValue<readonly number[]>;
};

let voiceInput: VoiceInput | null = null;

/**
 * The app has one microphone and one dictation at a time, so the session
 * lives for the app's lifetime rather than any screen's. T3 holds it in an
 * Effect atom; Apollo creates it on first use.
 */
function getVoiceInput(): VoiceInput {
  if (voiceInput) return voiceInput;
  const audioLevels = makeMutable<readonly number[]>(
    Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0),
  );
  let keepAwakeSequence = 0;
  const recorder = createLazyVoiceRecorder({
    create: () => new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
    onStatus: (status: RecordingStatus) => {
      void session.controller.handleRecorderStatus({
        isFinished: status.isFinished,
        hasError: status.hasError || status.mediaServicesDidReset === true,
        error: status.error,
        url: status.url,
      });
    },
  });
  const session: VoiceInputSession = new VoiceInputSession({
    recorder,
    getTranscriber: getLocalVoiceTranscriber,
    requestPermission: async () => {
      const permission = await requestRecordingPermissionsAsync();
      return { granted: permission.granted, canAskAgain: permission.canAskAgain };
    },
    configureRecording: () => setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }),
    releaseRecording: () => setAudioModeAsync({ allowsRecording: false }),
    deleteRecording: (uri) => new File(uri).delete(),
    sampleRecording: () => {
      const status = recorder.getStatus();
      return status?.isRecording
        ? { durationMillis: status.durationMillis, metering: status.metering }
        : null;
    },
    publishAudioLevels: (levels) => audioLevels.set(levels),
    keepAwake: () => keepScreenAwake(`voice-input:${++keepAwakeSequence}`),
  });
  // iOS reports `inactive` while its permission dialog is open. Only the real
  // background state cancels preparation; recorder status handles calls and
  // route interruptions during capture.
  AppState.addEventListener("change", (nextState) => {
    if (nextState === "background") void session.controller.appMovedToBackground();
  });
  voiceInput = { session, audioLevels };
  return voiceInput;
}

// The device language only changes across an app restart on iOS.
let available: boolean | null = null;
function isVoiceInputAvailable(): boolean {
  available ??= getLocalVoiceTranscriber() !== null;
  return available;
}

export function useGlobalVoiceInput() {
  const { session, audioLevels } = getVoiceInput();
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snapshot,
    isAvailable: isVoiceInputAvailable(),
    audioLevels,
    isBusy: voiceInputBlocksSubmission(snapshot.state),
    session,
    stop: () => session.controller.stop(),
    cancel: () => session.controller.cancel(),
  };
}
