import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import ts from 'typescript';
import type { EkhoContextValue } from './ekho-context';
import type { HermesModel, HermesRunEvent, HermesRunStatus } from './types';
import * as runState from './run-state.ts';
import * as attachments from './attachments.ts';
import * as messageHistory from './message-history.ts';

const { renderToString } = createRequire(import.meta.url)('react-dom/server') as { renderToString(element: React.ReactNode): string };


// Exercise the provider's real callbacks without loading native modules in Node.
// Server rendering supplies React's hooks; this test asserts network/subscription effects.
test('concurrent threads retain independent streams, controls, and saved run IDs', async () => {
  const streams = new Map<string, { onEvent(event: HermesRunEvent): void }>();
  const statuses = new Map<string, HermesRunStatus>();
  const stopped: string[] = [];
  const approved: string[] = [];
  let record = { id: 'agent', endpoint: { url: 'http://localhost' }, activeRunIds: [] as readonly string[] };
  let count = 0;
  const removal: string[] = [];
  let registrationError: Error | undefined;
  const storage = new Map<string, string>();
  const selections: (HermesModel | undefined)[] = [];
  const catalog = {
    get: () => record,
    list: () => [record],
    credentials: { get: async () => 'test-token' },
    update: async (_id: string, patch: Partial<typeof record>) => { record = { ...record, ...patch }; return record; },
    remove: async () => { removal.push('credential'); },
  };
  class Client {
    async capabilities() { return { features: {} }; }
    async sessions() { return []; }
    async sessionMessages() { return []; }
    async setSessionModel(sessionId: string, model: HermesModel) { return { sessionId, model: model.id, provider: model.provider }; }
    async startRun(_input: string, options: { sessionId: string }, selected?: HermesModel) {
      selections.push(selected);
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
  const source = ts.transpileModule(readFileSync(new URL('./ekho-context.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { EkhoProvider?: React.ComponentType<React.PropsWithChildren<{ catalog: unknown }>>; useEkho?: () => EkhoContextValue } = {};
  runInNewContext(source, {
    exports, clearTimeout,
    // Open subscriptions arm a quiet-stream check; it must not keep the test process alive.
    setTimeout: (callback: () => void, ms?: number) => setTimeout(callback, ms).unref(),
    require: (id: string) => {
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
        setItem: async (key: string, value: string) => { storage.set(key, value); },
        getAllKeys: async () => [...storage.keys()],
        multiRemove: async (keys: readonly string[]) => keys.forEach((key) => storage.delete(key)),
      } };
      if (id === './catalog') return {};
      if (id === './pairing') return { PairingClient: class {} };
      if (id === './run-state') return runState;
      if (id === './attachments') return attachments;
      if (id === './message-history') return messageHistory;
      if (id === './hermes-client') return { HermesClient: Client, HermesRequestError: class extends Error {}, parseSelectedModel: (value: HermesModel | null) => value ?? undefined };
      return nativeRequire(id);
    },
  });
  function mount() {
    let api: EkhoContextValue | undefined;
    function Capture() { api = exports.useEkho!(); return null; }
    renderToString(createElement(exports.EkhoProvider!, { catalog }, createElement(Capture)));
    return api!;
  }
  const api = mount();
  await api.refreshAgent('agent');
  const firstStart = api.startRun('agent', 'First', { sessionId: 'first' });
  await assert.rejects(api.startRun('agent', 'Duplicate', { sessionId: 'first' }), /current run/);
  const [first, second] = await Promise.all([firstStart, api.startRun('agent', 'Second', { sessionId: 'second' })]);
  assert.equal(streams.size, 2);
  assert.deepEqual(selections, [undefined, undefined]);
  assert.deepEqual(Array.from(record.activeRunIds), [first.runId, second.runId]);
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
  const third = await api.startRun('agent', 'Continue', { sessionId: 'first' });
  assert.deepEqual(JSON.parse(JSON.stringify(selections.at(-1))), { id: 'chosen', provider: 'alpha' });
  assert.deepEqual(Array.from(record.activeRunIds), [second.runId, third.runId]);
  streams.clear();
  const restored = mount();
  await restored.refreshAgent('agent');
  assert.deepEqual([...streams.keys()], [second.runId, third.runId]);
  await restored.stopRun('agent', third.runId);
  await restored.startRun('agent', 'After relaunch', { sessionId: 'first' });
  assert.deepEqual(JSON.parse(JSON.stringify(selections.at(-1))), { id: 'chosen', provider: 'alpha' });
  registrationError = new Error('Offline');
  await assert.rejects(restored.removeAgent('agent'), /Offline/);
  assert.deepEqual(removal, []);
  registrationError = undefined;
  await restored.removeAgent('agent');
  assert.deepEqual(removal, ['notification', 'credential']);
  assert.equal(streams.size, 0);
});
