import type { VoiceRecorder } from "./controller.ts";

export interface NativeVoiceRecorder<TStatus, TRecorderState> {
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(options: { readonly forDuration: number }): void;
  stop(): Promise<void>;
  getStatus(): TRecorderState;
  addListener(eventName: "recordingStatusUpdate", listener: (status: TStatus) => void): unknown;
}

export interface LazyVoiceRecorder<TRecorderState> extends VoiceRecorder {
  getStatus(): TRecorderState | null;
}

/** Construct lazily: cold startup blocks JS for tens of milliseconds and most composers never record. */
export function createLazyVoiceRecorder<TStatus, TRecorderState>(input: {
  readonly create: () => NativeVoiceRecorder<TStatus, TRecorderState>;
  readonly onStatus: (status: TStatus) => void;
}): LazyVoiceRecorder<TRecorderState> {
  let recorder: NativeVoiceRecorder<TStatus, TRecorderState> | null = null;

  return {
    get uri() {
      return recorder?.uri ?? null;
    },
    prepareToRecordAsync() {
      if (!recorder) {
        recorder = input.create();
        recorder.addListener("recordingStatusUpdate", input.onStatus);
      }
      return recorder.prepareToRecordAsync();
    },
    record(options) {
      if (!recorder) throw new Error("Voice recorder is not prepared.");
      recorder.record(options);
    },
    stop() {
      return recorder ? recorder.stop() : Promise.resolve();
    },
    getStatus() {
      return recorder ? recorder.getStatus() : null;
    },
  };
}
