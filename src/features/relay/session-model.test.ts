import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { ReactElement } from 'react';
import type { RunScreenProps } from './run-screen';
import type { HermesModel, HermesSession } from '../../lib/types';

// Run the route's callbacks and effects without loading native modules.
function routeFixture(id: string) {
  const restoration = Promise.withResolvers<void>();
  const session: HermesSession = { id };
  const saved: { sessionId: string; model: HermesModel }[] = [];
  const queued: unknown[] = [];
  const order: string[] = [];
  const slots = new Map<number, { value: unknown; deps?: readonly unknown[] }>();
  let cursor = 0;
  let effects: (() => unknown)[] = [];
  const memo = (factory: () => unknown, deps: readonly unknown[]) => {
    const index = cursor++;
    const previous = slots.get(index);
    if (!previous || deps.some((value, i) => value !== previous.deps?.[i])) slots.set(index, { value: factory(), deps });
    return slots.get(index)!.value;
  };
  const effect = (callback: () => unknown, deps: readonly unknown[]) => {
    memo(() => { effects.push(callback); }, deps);
  };
  const api = {
    agents: [{ id: 'agent', label: 'QA' }],
    runtime: { agent: { status: 'connected', sessions: id === 'new' ? [] : [session], runs: {}, events: [] } },
    messages: {}, skills: async () => [], models: async () => [], sessionMessages: async () => [],
    sessionDetail: async () => { await restoration.promise; session.model = 'shared'; session.selectedModel = { id: 'shared', provider: 'non-default' }; },
    saveModelSelection: async (_agent: string, sessionId: string, model: HermesModel) => { order.push('save'); saved.push({ sessionId, model }); },
  };
  const source = ts.transpileModule(readFileSync(new URL('../../app/(sessions)/session/[id].tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { Session?: (props: { id: string; agentId: string }) => ReactElement<{ children: ReactElement<RunScreenProps> }> } = {};
  runInNewContext(`${source}\nexports.Session = Session;`, {
    exports,
    require: (name: string) => {
      if (name === 'react/jsx-runtime') return { jsx: (type: unknown, props: unknown) => ({ type, props }) };
      if (name === 'react') return {
        useState: (initial: unknown) => {
          const index = cursor++;
          if (!slots.has(index)) slots.set(index, { value: initial });
          return [slots.get(index)!.value, (value: unknown) => slots.set(index, { value })];
        },
        useRef: (initial: unknown) => memo(() => ({ current: initial }), []),
        useMemo: memo, useCallback: (callback: unknown, deps: readonly unknown[]) => memo(() => callback, deps), useEffect: effect,
      };
      if (name === 'expo-router') return { useFocusEffect: (callback: () => unknown) => effect(callback, [callback]), useRouter: () => ({ setParams() {} }) };
      if (name === 'react-native') return { AppState: { currentState: 'active' } };
      if (name === '@/lib') return { useEkho: () => api };
      if (name === '@/lib/outbox-context') return { useOutbox: () => ({ loaded: true, items: [], enqueue: async (value: unknown) => { order.push('enqueue'); queued.push(value); } }) };
      if (name.endsWith('/use-session-draft')) return { useSessionDraft: () => ({ draft: '[QA] tiny', attachments: [], loaded: true, prepareSend: async () => ({ id: 'message', sessionId: id === 'new' ? 'created' : id, text: '[QA] tiny', attachments: [] }), move: async () => {}, clear: async () => {} }) };
      if (name.endsWith('/use-session-inbox')) return { useSessionInbox: () => ({ markRead: async () => {}, sessions: [] }) };
      if (name.endsWith('/relay-ui')) return { useThemedStyles: () => ({}) };
      if (name.endsWith('/transcript')) return { createTranscriptProjector: () => () => [] };
      if (name.endsWith('/composer-skills')) return { selectedSkillNames: () => [] };
      if (name.endsWith('/foreground')) return { setVisibleNotificationSession: () => {} };
      if (name === '@/features/sharing') return { useIncomingShares: () => ({}) };
      if (name.endsWith('/run-state')) return { sessionRun: () => undefined, isRunActive: () => false, currentApproval: () => undefined };
      if (name.endsWith('/hermes-client')) return { sessionModelChoice: (model?: string, cached?: HermesModel) => model ? { id: model, provider: cached?.id === model ? cached.provider : undefined } : cached };
      return {};
    },
  });
  const render = () => {
    cursor = 0; effects = [];
    const props = exports.Session!({ id, agentId: 'agent' }).props.children.props;
    effects.forEach((callback) => callback());
    return props;
  };
  return { render, restoration, saved, queued, order };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('existing threads cannot enqueue until model restoration succeeds', async () => {
  const setup = routeFixture('thread');
  const pending = setup.render();
  assert.equal(pending.sendDisabled, true);
  pending.onSend('[QA] tiny');
  await flush();
  assert.deepEqual(setup.queued, []);
  setup.restoration.resolve();
  await flush();
  const ready = setup.render();
  assert.equal(ready.sendDisabled, false);
  ready.onSend('[QA] tiny');
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(setup.queued[0])), { id: 'message', sessionId: 'thread', text: '[QA] tiny', attachments: [], agentId: 'agent', createsSession: false, model: 'shared', provider: 'non-default' });
});

test('a draft picker choice is saved under the creating message session before enqueue', async () => {
  const setup = routeFixture('new');
  setup.render().onSelectModel!({ id: 'shared', provider: 'non-default' });
  setup.render().onSend('[QA] tiny');
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(setup.saved)), [{ sessionId: 'created', model: { id: 'shared', provider: 'non-default' } }]);
  assert.deepEqual(setup.order, ['save', 'enqueue']);
});
