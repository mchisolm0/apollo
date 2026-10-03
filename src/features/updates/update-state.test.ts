import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSummary, createUpdateController, FOREGROUND_CHECK_INTERVAL_MS, releaseNotes, shouldNoticeUpdate, updateState, type UpdateState } from './update-state.ts';

const ready: UpdateState = { status: 'ready', update: { id: 'next-update', notes: [], rollback: false } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function environment() {
  let now = 0;
  let appState = 'active';
  let state: UpdateState = { status: 'idle' };
  const events: string[] = [];
  const env = {
    enabled: true,
    now: () => now,
    appState: () => appState,
    state: () => state,
    check: async () => { events.push('check'); return { isAvailable: true, isRollBackToEmbedded: false }; },
    fetch: async () => { events.push('fetch'); },
    flushDrafts: async () => { events.push('drafts'); return true; },
    withReloadSafety: async (apply: () => Promise<boolean>) => { events.push('outbox'); return apply(); },
    reload: async () => { events.push('reload'); },
  };
  return { env, events, advance: () => { now += FOREGROUND_CHECK_INTERVAL_MS; }, setState: (next: UpdateState) => { state = next; }, setAppState: (next: string) => { appState = next; } };
}

test('ready notices are once per update, only in the foreground', () => {
  assert.equal(shouldNoticeUpdate(ready, null, true), true);
  assert.equal(shouldNoticeUpdate(ready, 'next-update', true), false);
  assert.equal(shouldNoticeUpdate(ready, null, false), false);
  assert.equal(shouldNoticeUpdate({ status: 'downloading', progress: 1 }, null, true), false);
});

test('disabled updates are idle even with a pending download', () => {
  const snapshot = { isChecking: false, isDownloading: true, downloadProgress: 0, isUpdatePending: true, downloadedUpdate: { updateId: 'next', createdAt: new Date(0), manifest: {} } };
  assert.deepEqual(updateState(false, snapshot), { status: 'idle' });
  assert.equal(updateState(true, snapshot).status, 'ready');
  assert.deepEqual(updateState(true, { ...snapshot, isUpdatePending: false }), { status: 'downloading', progress: 0 });
  const rollback = updateState(true, { ...snapshot, downloadedUpdate: { createdAt: new Date(0) } });
  assert.equal(rollback.status === 'ready' && rollback.update.rollback, true);
});

test('release notes come from the downloaded manifest and reject malformed metadata', () => {
  assert.deepEqual(releaseNotes({ extra: { expoClient: { extra: { releaseNotes: ['Faster sync', 7, '', '   ', 'Saved drafts'] } } } }), ['Faster sync', 'Saved drafts']);
  for (const manifest of [null, {}, { extra: 'invalid' }, { extra: { expoClient: null } }]) assert.deepEqual(releaseNotes(manifest), []);
});

test('foreground checks are throttled and do not overlap', async () => {
  const setup = environment();
  const download = deferred<void>();
  setup.env.fetch = async () => { setup.events.push('fetch'); await download.promise; };
  const controller = createUpdateController(setup.env);
  await controller.onAppState('active');
  assert.deepEqual(setup.events, []);
  setup.advance();
  const checking = controller.onAppState('active');
  await Promise.resolve();
  setup.advance();
  await controller.onAppState('active');
  assert.deepEqual(setup.events, ['check', 'fetch']);
  download.resolve();
  await checking;
});

test('offline checks stay quiet and rollback directives are downloaded', async () => {
  const setup = environment();
  setup.env.check = async () => { throw new Error('offline'); };
  const controller = createUpdateController(setup.env);
  setup.advance();
  await controller.onAppState('active');
  setup.env.check = async () => ({ isAvailable: false, isRollBackToEmbedded: true });
  setup.advance();
  await controller.onAppState('active');
  assert.deepEqual(setup.events, ['fetch']);
});

test('quiet apply waits for both storage barriers, ignores inactive, and reloads once', async () => {
  const setup = environment();
  setup.setState(ready);
  const flushed = deferred<boolean>();
  setup.env.flushDrafts = () => flushed.promise;
  const controller = createUpdateController(setup.env);
  await controller.onAppState('inactive');
  assert.deepEqual(setup.events, []);
  setup.setAppState('background');
  const applying = controller.onAppState('background');
  assert.deepEqual(setup.events, ['outbox']);
  assert.equal(await controller.restart(), false);
  flushed.resolve(true);
  await applying;
  await controller.onAppState('background');
  assert.deepEqual(setup.events, ['outbox', 'reload']);
});

test('failed flushes and in-flight sends defer until the next background transition', async () => {
  for (const failure of ['draft', 'outbox', 'throw']) {
    const setup = environment();
    setup.setState(ready);
    setup.setAppState('background');
    if (failure === 'draft') setup.env.flushDrafts = async () => false;
    if (failure === 'outbox') setup.env.withReloadSafety = async () => false;
    if (failure === 'throw') setup.env.withReloadSafety = async () => { throw new Error('storage'); };
    const controller = createUpdateController(setup.env);
    await controller.onAppState('background');
    assert.equal(setup.events.includes('reload'), false);
    setup.env.flushDrafts = async () => true;
    setup.env.withReloadSafety = async (apply) => apply();
    await controller.onAppState('background');
    assert.equal(setup.events.includes('reload'), true);
  }
});

test('returning to foreground during a flush cancels quiet apply, even if backgrounded again', async () => {
  const setup = environment();
  setup.setState(ready);
  setup.setAppState('background');
  const flushed = deferred<boolean>();
  setup.env.flushDrafts = () => flushed.promise;
  const controller = createUpdateController(setup.env);
  const applying = controller.onAppState('background');
  setup.setAppState('active');
  await controller.onAppState('active');
  setup.setAppState('background');
  await controller.onAppState('background');
  flushed.resolve(true);
  await applying;
  assert.equal(setup.events.includes('reload'), false);
});

test('manual restart uses the same safety barrier and allows retry after a reload failure', async () => {
  const setup = environment();
  setup.setState(ready);
  setup.env.reload = async () => { throw new Error('native reload failed'); };
  const controller = createUpdateController(setup.env);
  assert.equal(await controller.restart(), false);
  setup.env.reload = async () => { setup.events.push('reload'); };
  assert.equal(await controller.restart(), true);
  assert.equal(await controller.restart(), false);
  assert.deepEqual(setup.events, ['outbox', 'drafts', 'outbox', 'drafts', 'reload']);
});

test('development and disabled builds never check or restart', async () => {
  const setup = environment();
  setup.env.enabled = false;
  const controller = createUpdateController(setup.env);
  setup.advance();
  await controller.onAppState('active');
  setup.setState(ready);
  setup.setAppState('background');
  await controller.onAppState('background');
  assert.equal(await controller.restart(), false);
  assert.deepEqual(setup.events, []);
});

test('About uses native build, channel, update identity, and relative age', () => {
  const info = { version: '1.2.3', build: '42', channel: 'preview', development: false, embedded: false, updateId: 'a1b2c3-rest', createdAt: new Date(0) };
  assert.equal(buildSummary(info, 2 * 60 * 60 * 1000), '1.2.3 (42) · preview · update a1b2c3 · 2h ago');
  assert.equal(buildSummary({ ...info, embedded: true }, 0), '1.2.3 (42) · preview · embedded · just now');
  assert.equal(buildSummary({ version: null, build: null, development: true, embedded: false }, 0), 'Unknown · development');
  assert.equal(buildSummary({ version: '1.2.3', build: '42', development: false, embedded: true }, 0), '1.2.3 (42) · embedded');
});
