import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { ReactElement } from 'react';
import type { RunScreenProps } from './run-screen';
import type { HermesModel } from '../../lib/types';

// Run send callbacks without loading native modules or display effects.
function routeFixture(id: string) {
  const saved: { sessionId: string; model: HermesModel }[] = [];
  const queued: unknown[] = [];
  const order: string[] = [];
  const resolved: { sessionId: string; creating?: boolean }[] = [];
  const slots = new Map<number, unknown>();
  let cursor = 0;
  const api = {
    agents: [{ id: 'agent', label: 'QA' }],
    runtime: { agent: { status: 'connected', sessions: id === 'new' ? [] : [{ id }], runs: {}, events: [] } },
    messages: {}, skills: async () => [], models: async () => [], sessionMessages: async () => [],
    resolveThreadModel: async (_agent: string, sessionId: string, options?: { creating?: boolean }) => { resolved.push({ sessionId, creating: options?.creating }); return saved.at(-1)?.model; },
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
          if (!slots.has(index)) slots.set(index, initial);
          return [slots.get(index), (value: unknown) => slots.set(index, value)];
        },
        useRef: (initial: unknown) => ({ current: initial }),
        useMemo: (factory: () => unknown) => factory(), useCallback: (callback: unknown) => callback, useEffect() {},
      };
      if (name === 'expo-router') return { useFocusEffect() {}, useRouter: () => ({ setParams() {} }) };
      if (name === 'react-native') return { AppState: { currentState: 'active' } };
      if (name === '@/lib') return { useEkho: () => api };
      if (name === '@/lib/outbox-context') return { useOutbox: () => ({ loaded: true, items: [], enqueue: async (value: unknown) => { order.push('enqueue'); queued.push(value); } }) };
      if (name.endsWith('/use-session-draft')) return { useSessionDraft: () => ({ draft: '[QA] tiny', attachments: [], loaded: true, prepareSend: async () => ({ id: 'message', sessionId: id === 'new' ? 'created' : id, text: '[QA] tiny', attachments: [] }), move: async () => {}, clear: async () => {} }) };
      if (name.endsWith('/use-session-inbox')) return { useSessionInbox: () => ({ markRead: async () => {}, sessions: [] }) };
      if (name.endsWith('/relay-ui')) return { useThemedStyles: () => ({}) };
      if (name.endsWith('/transcript')) return { createTranscriptProjector: () => () => [] };
      if (name.endsWith('/composer-skills')) return { selectedSkillNames: () => [] };
      if (name === '@/features/sharing') return { useIncomingShares: () => ({}) };
      if (name.endsWith('/run-state')) return { sessionRun: () => undefined, isRunActive: () => false, currentApproval: () => undefined };
      return {};
    },
  });
  const render = () => {
    cursor = 0;
    return exports.Session!({ id, agentId: 'agent' }).props.children.props;
  };
  return { render, saved, queued, order, resolved };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a draft picker choice is saved under the creating message session before enqueue', async () => {
  const setup = routeFixture('new');
  setup.render().onSelectModel!({ id: 'shared', provider: 'non-default' });
  setup.render().onSend('[QA] tiny');
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(setup.saved)), [{ sessionId: 'created', model: { id: 'shared', provider: 'non-default' } }]);
  assert.deepEqual(setup.order, ['save', 'enqueue']);
  assert.deepEqual(setup.resolved, [{ sessionId: 'created', creating: true }]);
  const [queued] = setup.queued as { model?: string; provider?: string }[];
  assert.deepEqual({ model: queued.model, provider: queued.provider }, { model: 'shared', provider: 'non-default' });
});
