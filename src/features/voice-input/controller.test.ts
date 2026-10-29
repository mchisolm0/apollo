import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
  resetVoiceInputGlobalsForTests,
  resolveTranscriptCommit,
  VoiceInputController,
  VOICE_RECORDING_LIMIT_SECONDS,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputPhase,
} from './controller.ts';
import type { PreparedVoiceTranscription } from './transcription.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function draft(overrides: Partial<VoiceDraftSnapshot> = {}): VoiceDraftSnapshot {
  return { ownerKey: 'thread', text: 'hello world', selection: { start: 6, end: 11 }, revision: 0, ...overrides };
}

function prepared(transcribe: PreparedVoiceTranscription['transcribe'] = async () => 'new text'): PreparedVoiceTranscription {
  return { locale: 'en-US', transcribe };
}

function createHarness(overrides: Partial<VoiceInputControllerDependencies> = {}, initialDraft = draft()) {
  let currentDraft: VoiceDraftSnapshot | null = initialDraft;
  const events: string[] = [];
  const phases: VoiceInputPhase[] = [];
  const commits: { text: string; selection: { start: number; end: number } }[] = [];
  const recorded: { forDuration: number }[] = [];
  const deleted: string[] = [];
  const controller = new VoiceInputController({
    recorder: {
      uri: 'file:///voice.m4a',
      prepareToRecordAsync: async () => undefined,
      record: (options) => { recorded.push(options); },
      stop: async () => { events.push('stopped'); },
    },
    getTranscriber: () => ({ prepare: async () => prepared(async () => { events.push('transcribed'); return 'new text'; }) }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => undefined,
    releaseRecording: async () => { events.push('released'); },
    deleteRecording: (uri) => { deleted.push(uri); },
    readDraft: () => currentDraft,
    commitDraft: (text, selection) => { commits.push({ text, selection }); },
    onStateChange: (state) => { phases.push(state.phase); },
    ...overrides,
  });
  return { controller, events, phases, commits, recorded, deleted, setDraft: (next: VoiceDraftSnapshot | null) => { currentDraft = next; } };
}

describe('resolveTranscriptCommit', () => {
  test('inserts at the cursor with a word boundary and moves the cursor after it', () => {
    const captured = draft({ text: 'Fix it', selection: { start: 6, end: 6 } });
    assert.deepEqual(resolveTranscriptCommit(captured, captured, ' then ship ', 'en_US'), {
      kind: 'commit',
      text: 'Fix it then ship',
      selection: { start: 16, end: 16 },
    });
    const between = draft({ text: 'ab cd', selection: { start: 3, end: 3 } });
    assert.deepEqual(resolveTranscriptCommit(between, between, 'xy', 'en-US'), { kind: 'commit', text: 'ab xy cd', selection: { start: 6, end: 6 } });
  });

  test('replaces the captured selection and adds no spacing outside English', () => {
    const captured = draft();
    assert.deepEqual(resolveTranscriptCommit(captured, captured, 'there', 'en-US'), { kind: 'commit', text: 'hello there', selection: { start: 11, end: 11 } });
    const end = draft({ text: 'hej', selection: { start: 3, end: 3 } });
    assert.deepEqual(resolveTranscriptCommit(end, end, 'världen', 'sv-SE'), { kind: 'commit', text: 'hejvärlden', selection: { start: 10, end: 10 } });
  });

  test('refuses a changed draft and an empty transcript', () => {
    const captured = draft();
    assert.deepEqual(resolveTranscriptCommit(captured, draft({ text: 'newer' }), 'text', 'en-US'), { kind: 'stale' });
    assert.deepEqual(resolveTranscriptCommit(captured, draft({ ownerKey: 'other' }), 'text', 'en-US'), { kind: 'stale' });
    assert.deepEqual(resolveTranscriptCommit(captured, null, 'text', 'en-US'), { kind: 'stale' });
    assert.deepEqual(resolveTranscriptCommit(captured, captured, '  ', 'en-US'), { kind: 'empty' });
  });
});

describe('VoiceInputController', () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  test('hides behind support and permission checks', async () => {
    const unsupported = createHarness({ getTranscriber: () => null });
    await unsupported.controller.start();
    assert.equal(unsupported.controller.currentState.phase, 'error');
    assert.equal(unsupported.recorded.length, 0);

    const denied = createHarness({ requestPermission: async () => ({ granted: false, canAskAgain: false }) });
    await denied.controller.start();
    assert.equal(denied.controller.currentState.errorAction, 'settings');

    const askAgain = createHarness({ requestPermission: async () => ({ granted: false, canAskAgain: true }) });
    await askAgain.controller.start();
    assert.equal(askAgain.controller.currentState.errorAction, 'retry');
    assert.equal(askAgain.recorded.length, 0);
  });

  test('records up to five minutes, releases the mic, then commits one transcript', async () => {
    const harness = createHarness();
    await harness.controller.start();
    assert.deepEqual(harness.recorded, [{ forDuration: VOICE_RECORDING_LIMIT_SECONDS }]);
    assert.equal(VOICE_RECORDING_LIMIT_SECONDS, 300);

    await harness.controller.stop();
    assert.deepEqual(harness.phases, ['preparing', 'recording', 'transcribing', 'idle']);
    assert.deepEqual(harness.events, ['stopped', 'released', 'transcribed']);
    assert.deepEqual(harness.commits, [{ text: 'hello new text', selection: { start: 14, end: 14 } }]);
    assert.deepEqual(harness.deleted, ['file:///voice.m4a']);
  });

  test('transcribes when the recorder hits its limit on its own', async () => {
    const harness = createHarness();
    await harness.controller.start();
    await harness.controller.handleRecorderStatus({ isFinished: true, hasError: false, error: null, url: 'file:///voice.m4a' });
    assert.equal(harness.commits.length, 1);
    assert.ok(!harness.events.includes('stopped'));
  });

  test('cancel discards the recording without committing', async () => {
    const harness = createHarness();
    await harness.controller.start();
    harness.controller.cancel();
    assert.equal(harness.controller.currentState.phase, 'idle');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.commits, []);
    assert.deepEqual(harness.deleted, ['file:///voice.m4a']);
    assert.ok(harness.events.includes('released'));
  });

  test('backgrounding stops a recording with a retryable error', async () => {
    const harness = createHarness();
    await harness.controller.start();
    await harness.controller.appMovedToBackground();
    assert.deepEqual(harness.controller.currentState, { phase: 'error', error: 'Voice recording was interrupted.', errorAction: 'retry' });
    assert.deepEqual(harness.commits, []);
  });

  test('a draft edited during transcription keeps the edit and drops the transcript', async () => {
    const transcription = deferred<string>();
    const entered = deferred<void>();
    const harness = createHarness({
      getTranscriber: () => ({ prepare: async () => prepared(() => { entered.resolve(); return transcription.promise; }) }),
    });
    await harness.controller.start();
    const stopping = harness.controller.stop();
    await entered.promise;
    harness.setDraft(draft({ text: 'edited' }));
    transcription.resolve('late text');
    await stopping;
    assert.deepEqual(harness.commits, []);
    assert.match(harness.controller.currentState.error ?? '', /draft changed/);
  });
});
