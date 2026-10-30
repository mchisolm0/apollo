import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { resetVoiceInputGlobalsForTests, type VoiceInputPhase } from './controller.ts';
import { createVoiceInputTarget, VoiceInputSession, type VoiceRecordingSample } from './voiceInputSession.ts';

beforeEach(() => {
  resetVoiceInputGlobalsForTests();
  mock.timers.enable({ apis: ['setInterval'] });
});
afterEach(() => mock.timers.reset());

test('a recording that stops reporting for longer than a finish takes is interrupted', async () => {
  const samples: (VoiceRecordingSample | null)[] = [null, null, { durationMillis: 1_000, metering: -30 }, null];
  const session = new VoiceInputSession({
    recorder: { uri: 'file:///voice.m4a', prepareToRecordAsync: async () => undefined, record: () => undefined, stop: async () => undefined },
    getTranscriber: () => ({ prepare: async () => ({ locale: 'en-US', transcribe: async () => 'text' }) }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => undefined,
    releaseRecording: async () => undefined,
    deleteRecording: () => undefined,
    sampleRecording: () => samples.shift() ?? null,
    publishAudioLevels: () => undefined,
    keepAwake: () => () => undefined,
  });
  const phase = (): VoiceInputPhase => session.getSnapshot().state.phase;

  await session.start(createVoiceInputTarget('thread', () => '', () => undefined, { start: 0, end: 0 }));
  assert.equal(phase(), 'recording');

  // Not reporting yet right after record() is still a recording that is starting.
  mock.timers.tick(80);
  assert.equal(phase(), 'recording');
  mock.timers.tick(80);
  assert.equal(session.getSnapshot().elapsedSeconds, 1);

  // expo-audio stops reporting just before it delivers a finished recording.
  mock.timers.tick(80 * 11);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(phase(), 'recording');

  mock.timers.tick(80);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(phase(), 'error');
  assert.equal(session.getSnapshot().state.error, 'Voice recording was interrupted.');
});
