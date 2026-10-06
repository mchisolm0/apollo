import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import ts from 'typescript';
import type { ApolloContextValue } from './apollo-context';
import type { HermesModel, HermesRunEvent, HermesRunStatus, HermesSession, StartRunOptions } from './types';
import { createOutboxRuntime } from './outbox.ts';
import * as runState from './run-state.ts';
import * as attachments from './attachments.ts';
import * as messageHistory from './message-history.ts';

const { renderToString } = createRequire(import.meta.url)('react-dom/server') as { renderToString(element: React.ReactNode): string };


// Exercise the provider's real callbacks without loading native modules in Node.
// Server rendering supplies React's hooks; this test asserts network/subscription effects.
function providerFixture(sessions: readonly HermesSession[] = []) {
  const streams = new Map<string, { onEvent(event: HermesRunEvent): void }>();
  const statuses = new Map<string, HermesRunStatus>();
  const stopped: string[] = [];
  const approved: string[] = [];
  let record = { id: 'agent', endpoint: { url: 'http://localhost' }, activeRunIds: [] as readonly string[] };
  let count = 0;
  const removal: string[] = [];
  let registrationError: Error | undefined;
  let storageError: Error | undefined;
  const storage = new Map<string, string>();
  const requests: { input: string; options: StartRunOptions }[] = [];
  const locks: HermesModel[] = [];
  let loseAcceptance = false;
  const detail = Promise.withResolvers<HermesSession>();
  let detailResult = detail.promise;
  let detailRequests = 0;
  const reconnect = Promise.withResolvers<void>();
  let reconnecting = false;
  const catalog = {
    get: () => record,
    list: () => [record],
    credentials: { get: async () => 'test-token' },
    update: async (_id: string, patch: Partial<typeof record>) => { record = { ...record, ...patch }; return record; },
    remove: async () => { removal.push('credential'); },
  };
  class Client {
    async capabilities() { if (reconnecting) await reconnect.promise; return { features: {} }; }
    async sessions() { return sessions; }
    async session() { detailRequests++; return detailResult; }
    async sessionMessages() { return []; }
    async deleteSession() {}
    async setSessionModel(sessionId: string, model: HermesModel) { locks.push(model); return { sessionId, model: model.id, provider: model.provider }; }
    async startRun(input: string, options: StartRunOptions) {
      requests.push({ input, options: { ...options } });
      if (loseAcceptance) { loseAcceptance = false; throw new Error('Connection lost'); }
      await Promise.resolve();
      const run: HermesRunStatus = { runId: `run-${++count}`, sessionId: options.sessionId, status: 'running' };
      statuses.set(run.runId, run);
      return run;
    }
    async runStatus(id: string) { return statuses.get(id)!; }
    subscribeRunEvents(id: string, callbacks: { onEvent(event: HermesRunEvent): void }) {
      streams.set(id, callbacks);
      return { close: () => streams.delete(id) };
    }
    async stopRun(id: string) {
      stopped.push(id);
      const run = { ...statuses.get(id)!, status: 'cancelled' as const };
      statuses.set(id, run);
      return run;
    }
    async approveRun(id: string) { approved.push(id); return { runId: id }; }
  }
  const nativeRequire = createRequire(import.meta.url);
  const react = nativeRequire('react') as typeof import('react');
  let stateIndex = 0;
  let latestRuntime: ApolloContextValue['runtime'] = {};
  const source = ts.transpileModule(readFileSync(new URL('./apollo-context.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { ApolloProvider?: React.ComponentType<React.PropsWithChildren<{ catalog: unknown }>>; useApollo?: () => ApolloContextValue } = {};
  runInNewContext(source, {
    exports, clearTimeout, AbortController,
    // Open subscriptions arm a quiet-stream check; it must not keep the test process alive.
    setTimeout: (callback: () => void, ms?: number) => setTimeout(callback, ms).unref(),
    require: (id: string) => {
      if (id === 'react') return { ...react, useState: (initial: unknown) => {
        const [value, setValue] = react.useState(initial);
        const runtimeState = ++stateIndex === 2;
        return [value, (next: unknown) => {
          if (runtimeState) latestRuntime = next as ApolloContextValue['runtime'];
          setValue(next);
        }];
      } };
      if (id === '@/config/posthog') return { posthog: { capture() {} } };
      if (id === '@/features/notifications/notifications') return {
        createNotificationRegistrationClient: () => ({ unregister: async () => {
          if (registrationError) throw registrationError;
          removal.push('notification');
        } }),
      };
      if (id === 'react-native') return { AppState: {} };
      if (id === '@react-native-async-storage/async-storage') return { __esModule: true, default: {
        getItem: async (key: string) => storage.get(key) ?? null,
        setItem: async (key: string, value: string) => { if (storageError) throw storageError; storage.set(key, value); },
        removeItem: async (key: string) => { if (storageError) throw storageError; storage.delete(key); },
        getAllKeys: async () => [...storage.keys()],
        multiRemove: async (keys: readonly string[]) => { if (storageError) throw storageError; keys.forEach((key) => storage.delete(key)); },
      } };
      if (id === './catalog') return {};
      if (id === './pairing') return { PairingClient: class {} };
      if (id === './run-state') return runState;
      if (id === './attachments') return attachments;
      if (id === './message-history') return messageHistory;
      if (id === './hermes-client') return { HermesClient: Client, HermesRequestError: class extends Error {}, parseSelectedModel: (value: HermesModel | null) => value ?? undefined, sessionModelChoice: (model: string | undefined, cached?: HermesModel) => model ? { id: model, provider: model === cached?.id ? cached.provider : undefined } : cached };
      return nativeRequire(id);
    },
  });
  function mount() {
    stateIndex = 0;
    let api: ApolloContextValue | undefined;
    function Capture() { api = exports.useApollo!(); return null; }
    renderToString(createElement(exports.ApolloProvider!, { catalog }, createElement(Capture)));
    return api!;
  }
  return { mount, streams, stopped, approved, removal, requests, locks, resolveDetail: detail.resolve,
    get record() { return record; },
    get detailRequests() { return detailRequests; },
    setDetail: (session: HermesSession) => { detailResult = Promise.resolve(session); },
    holdReconnect: () => { reconnecting = true; }, releaseReconnect: reconnect.resolve,
    get runtime() { return latestRuntime; },
    loseNextAcceptance: () => { loseAcceptance = true; },
    setRegistrationError: (error?: Error) => { registrationError = error; },
    setStorageError: (error?: Error) => { storageError = error; },
  };
}

test('concurrent threads retain independent streams, controls, and saved run IDs', async () => {
  const setup = providerFixture();
  const { mount, streams, stopped, approved, removal, requests } = setup;
  const api = mount();
  await api.refreshAgent('agent');
  const firstStart = api.startRun('agent', 'First', { sessionId: 'first' });
  await assert.rejects(api.startRun('agent', 'Duplicate', { sessionId: 'first' }), /current run/);
  const [first, second] = await Promise.all([firstStart, api.startRun('agent', 'Second', { sessionId: 'second' })]);
  assert.equal(streams.size, 2);
  assert.equal(requests[0].options.model, undefined);
  assert.equal(requests[1].options.model, undefined);
  assert.deepEqual(Array.from(setup.record.activeRunIds), [first.runId, second.runId]);
  await assert.rejects(api.startRun('agent', 'Duplicate after start', { sessionId: 'first' }), /current run/);
  await api.approveRun('agent', second.runId, 'once');
  assert.deepEqual(approved, [second.runId]);
  await api.stopRun('agent', first.runId);
  streams.get(first.runId)!.onEvent({ event: 'run.cancelled' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(stopped, [first.runId]);
  assert.equal(streams.has(first.runId), false);
  assert.equal(streams.has(second.runId), true);
  await api.setSessionModel('agent', 'first', { id: 'chosen', provider: 'alpha' });
  const third = await api.startRun('agent', 'Continue', { sessionId: 'first', model: 'chosen', provider: 'alpha' });
  assert.equal(requests.at(-1)?.options.model, 'chosen');
  assert.deepEqual(Array.from(setup.record.activeRunIds), [second.runId, third.runId]);
  streams.clear();
  const restored = mount();
  await restored.refreshAgent('agent');
  assert.deepEqual([...streams.keys()], [second.runId, third.runId]);
  await restored.stopRun('agent', third.runId);
  await restored.startRun('agent', 'After relaunch', { sessionId: 'first' });
  assert.equal(requests.at(-1)?.options.model, undefined);
  assert.equal(requests.at(-1)?.options.provider, undefined);
  setup.setRegistrationError(new Error('Offline'));
  await assert.rejects(restored.removeAgent('agent'), /Offline/);
  assert.deepEqual(removal, []);
  setup.setRegistrationError();
  await restored.removeAgent('agent');
  assert.deepEqual(removal, ['notification', 'credential']);
  assert.equal(streams.size, 0);
});


function queueFor(api: ApolloContextValue, initial: string | null = null) {
  let saved = initial;
  return createOutboxRuntime({
    storage: { getItem: async () => saved, setItem: async (_, value) => { saved = value; } },
    canSend: () => true,
    deliver: async (message) => (await api.startRun(message.agentId, message.text, {
      sessionId: message.sessionId, idempotencyKey: message.id, model: message.model, provider: message.provider,
    })).runId,
    discardAttachments: () => {},
  });
}

const queued = { id: 'message', agentId: 'agent', sessionId: 'thread', createsSession: false, text: '[QA] tiny', attachments: [], model: 'A', provider: 'alpha' };

test('opening a thread preserves list activity and preview omitted by detail', async () => {
  const listed = { id: 'thread', title: 'Old title', startedAt: 100, lastActive: 900, preview: 'Recent message', pinned: true };
  const setup = providerFixture([listed]);
  const api = setup.mount();
  await api.refreshAgent('agent');
  setup.resolveDetail({ id: 'thread', title: 'Fresh title', lastActive: undefined, preview: undefined, pinned: false });
  await api.sessionDetail('agent', 'thread');
  assert.deepEqual(JSON.parse(JSON.stringify(setup.runtime.agent.sessions[0])), { ...listed, title: 'Fresh title', pinned: false });
});

test('send resolution keeps a stored provider after a session list refresh and relaunch', async () => {
  const setup = providerFixture([{ id: 'thread', model: 'shared' }]);
  const api = setup.mount();
  await api.saveModelSelection('agent', 'thread', { id: 'shared', provider: 'non-default' });
  const restored = setup.mount();
  await restored.refreshAgent('agent');
  assert.equal(setup.runtime.agent.sessions[0].selectedModel, undefined);
  setup.setDetail({ id: 'thread', model: 'shared' });
  const choice = await restored.resolveThreadModel('agent', 'thread');
  assert.deepEqual(JSON.parse(JSON.stringify(choice)), { id: 'shared', provider: 'non-default' });
  await restored.startRun('agent', '[QA] tiny', { sessionId: 'thread', model: choice?.id, provider: choice?.provider });
  assert.equal(setup.requests.at(-1)?.options.provider, 'non-default');
  assert.deepEqual(setup.locks, []);
});

test('send during reconnect fetches fresh detail rather than the previous display model', async () => {
  const setup = providerFixture([{ id: 'thread', model: 'old' }]);
  const api = setup.mount();
  await api.refreshAgent('agent');
  await api.saveModelSelection('agent', 'thread', { id: 'old', provider: 'alpha' });
  setup.holdReconnect();
  const refreshing = api.refreshAgent('agent');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.runtime.agent.status, 'connecting');
  setup.setDetail({ id: 'thread', model: 'fresh' });
  assert.deepEqual(JSON.parse(JSON.stringify(await api.resolveThreadModel('agent', 'thread'))), { id: 'fresh' });
  assert.equal(setup.detailRequests, 1);
  setup.releaseReconnect();
  await refreshing;
});

test('send resolution falls back to the stored choice when detail never answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const setup = providerFixture([{ id: 'thread', model: 'listed' }]);
  const api = setup.mount();
  await api.refreshAgent('agent');
  await api.saveModelSelection('agent', 'thread', { id: 'listed', provider: 'alpha' });
  const resolving = api.resolveThreadModel('agent', 'thread');
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4_000);
  assert.deepEqual(JSON.parse(JSON.stringify(await resolving)), { id: 'listed', provider: 'alpha' });
});

test('send resolution falls back to the listed model when nothing was picked on this device', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const setup = providerFixture([{ id: 'thread', model: 'listed' }]);
  const api = setup.mount();
  await api.refreshAgent('agent');
  const resolving = api.resolveThreadModel('agent', 'thread');
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4_000);
  assert.deepEqual(JSON.parse(JSON.stringify(await resolving)), { id: 'listed' });
});

test('a creating send resolves locally without requesting detail', async () => {
  const setup = providerFixture([]);
  const api = setup.mount();
  await api.refreshAgent('agent');
  await api.saveModelSelection('agent', 'created', { id: 'picked', provider: 'beta' });
  assert.deepEqual(JSON.parse(JSON.stringify(await api.resolveThreadModel('agent', 'created', { creating: true }))), { id: 'picked', provider: 'beta' });
  assert.equal(setup.detailRequests, 0);
});

test('accepted model changes update runtime even when the local cache cannot save', async () => {
  const setup = providerFixture([{ id: 'thread', model: 'old' }]);
  const api = setup.mount();
  await api.refreshAgent('agent');
  setup.setStorageError(new Error('Disk full'));
  const lock = await api.setSessionModel('agent', 'thread', { id: 'new', provider: 'non-default' });
  assert.equal(lock.model, 'new');
  assert.deepEqual(JSON.parse(JSON.stringify(setup.runtime.agent.sessions[0].selectedModel)), { id: 'new', provider: 'non-default' });
});

test('deleted threads leave runtime even when their model cache cannot be removed', async () => {
  const setup = providerFixture([{ id: 'thread' }]);
  const api = setup.mount();
  await api.refreshAgent('agent');
  setup.setStorageError(new Error('Disk full'));
  await api.deleteSession('agent', 'thread');
  assert.equal(api.hasSession('agent', 'thread'), false);
});

test('failed cache cleanup leaves agent removal retryable', async () => {
  const setup = providerFixture();
  const api = setup.mount();
  await api.refreshAgent('agent');
  setup.setStorageError(new Error('Disk full'));
  await assert.rejects(api.removeAgent('agent'), /Disk full/);
  assert.deepEqual(setup.removal, ['notification']);
  setup.setStorageError();
  await api.removeAgent('agent');
  assert.deepEqual(setup.removal, ['notification', 'notification', 'credential']);
});

test('removing and reconnecting an agent discards its pending session detail', async () => {
  const setup = providerFixture();
  const api = setup.mount();
  await api.refreshAgent('agent');
  const pending = api.sessionDetail('agent', 'old-thread');
  await api.removeAgent('agent');
  await api.refreshAgent('agent');
  setup.resolveDetail({ id: 'old-thread', title: 'Old thread' });
  await pending;
  assert.equal(api.hasSession('agent', 'old-thread'), false);
});

test('a lost acceptance retries the same queued snapshot after the picker changes', async () => {
  const setup = providerFixture();
  const api = setup.mount();
  await api.refreshAgent('agent');
  await api.setSessionModel('agent', 'thread', { id: 'A', provider: 'alpha' });
  const outbox = queueFor(api);
  try {
    await outbox.enqueue(queued);
    setup.loseNextAcceptance();
    await outbox.drain();
    await api.setSessionModel('agent', 'thread', { id: 'B', provider: 'beta' });
    await outbox.retry(queued.id);
    await outbox.drain();
    assert.equal(setup.requests.length, 2);
    assert.deepEqual(setup.requests[0], setup.requests[1]);
    assert.deepEqual(setup.requests[1].options, { sessionId: 'thread', idempotencyKey: 'message', model: 'A', provider: 'alpha' });
    assert.deepEqual(outbox.getSnapshot().items, []);
  } finally { await outbox.dispose(); }
});

test('draining model A does not relock a thread explicitly changed to B', async () => {
  const setup = providerFixture();
  const api = setup.mount();
  await api.refreshAgent('agent');
  const outbox = queueFor(api);
  try {
    await outbox.enqueue(queued);
    await api.setSessionModel('agent', 'thread', { id: 'B', provider: 'beta' });
    await outbox.drain();
    assert.deepEqual(setup.locks, [{ id: 'B', provider: 'beta' }]);
    assert.equal(setup.requests[0].options.model, 'A');
    assert.equal(setup.requests[0].options.provider, 'alpha');
  } finally { await outbox.dispose(); }
});

test('an older persisted outbox item without a model snapshot sends no override', async () => {
  const setup = providerFixture();
  const api = setup.mount();
  await api.refreshAgent('agent');
  await api.setSessionModel('agent', 'thread', { id: 'B', provider: 'beta' });
  const { model: _model, provider: _provider, ...legacy } = queued;
  const outbox = queueFor(api, JSON.stringify([{ ...legacy, state: 'queued', attempts: 0, createdAt: Date.now() }]));
  try {
    await outbox.drain();
    assert.equal(setup.requests[0].options.model, undefined);
    assert.equal(setup.requests[0].options.provider, undefined);
    assert.equal(setup.locks.length, 1);
  } finally { await outbox.dispose(); }
});
