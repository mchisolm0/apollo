import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as attachments from './attachments.ts';
import * as endpoint from './endpoint.ts';
import * as protocol from './protocol.ts';
import * as skills from './skills.ts';
import type { HermesModel } from './types.ts';

// hermes-client imports react-native-sse, so load it transpiled with the native dep stubbed.
function loadClient() {
  const source = ts.transpileModule(readFileSync(new URL('./hermes-client.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: {
    HermesClient?: typeof import('./hermes-client').HermesClient;
    parseModels?: (value: unknown) => readonly HermesModel[];
    parseSelectedModel?: typeof import('./hermes-client').parseSelectedModel;
  } = {};
  runInNewContext(source, {
    exports,
    require: (id: string) => {
      if (id === 'react-native-sse') return { default: class {} };
      if (id === './attachments') return attachments;
      if (id === './endpoint') return endpoint;
      if (id === './skills') return skills;
      if (id === './protocol') return protocol;
      return createRequire(import.meta.url)(id);
    },
  });
  return exports as Required<typeof exports>;
}

function stubFetch(body: unknown, seen: { url?: string; init?: RequestInit }[] = []) {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return { ok: true, json: async () => body };
  }) as unknown as typeof fetch;
}

const { HermesClient, parseModels, parseSelectedModel } = loadClient();
// Values cross the vm boundary with foreign prototypes; compare their plain JSON shape.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const clientWith = (body: unknown, seen: { url?: string; init?: RequestInit }[] = []) =>
  new HermesClient({ endpoint: 'https://agent.example.ts.net', token: 'token', fetchImpl: stubFetch(body, seen) });

test('models parser tolerates unknown shapes and skips malformed entries', () => {
  assert.deepEqual(plain(parseModels({ data: [{ id: 'hermes-large' }, null, { id: '' }, { name: 'hermes-mini', provider: 'Hermes' }] })), [
    { id: 'hermes-large' },
    { id: 'hermes-mini', provider: 'Hermes' },
  ]);
  assert.deepEqual(plain(parseModels({ models: [{ id: 'a', default: true }] })), [
    { id: 'a', default: true },
  ]);
  assert.deepEqual(plain(parseModels([{ id: 'b' }])), [{ id: 'b' }]);
  for (const shape of [{}, { data: {} }, null, undefined, 'models']) assert.deepEqual(plain(parseModels(shape)), []);
});

test('models() rejects an invalid provider inventory', async () => {
  await assert.rejects(clientWith({ unexpected: true }).models(), /model options response was invalid/);
});

test('models prefers the provider inventory and retains duplicate IDs across providers', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const models = await clientWith({ model: 'shared', provider: 'alpha', providers: [
    { slug: 'alpha', models: ['shared', 'shared', 'blocked', null, ''], unavailable_models: ['blocked'] },
    { slug: 'beta', models: ['shared'] },
    { slug: 'unconfigured', authenticated: false, models: ['hidden'] },
    { models: ['invalid'] },
  ] }, seen).models();
  assert.deepEqual(plain(models), [
    { id: 'shared', provider: 'alpha', default: true },
    { id: 'shared', provider: 'beta', default: false },
  ]);
  assert.equal(seen[0]?.url, 'https://agent.example.ts.net/api/model/options');
});

test('models falls back only on missing or forbidden inventory routes', async () => {
  for (const status of [403, 404, 401, 500]) {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(url.endsWith('/v1/models') ? { data: [{ id: 'compat', owned_by: 'hermes' }] } : { error: { message: 'Unavailable' } }),
        { status: url.endsWith('/v1/models') ? 200 : status });
    }) as typeof fetch;
    const client = new HermesClient({ endpoint: 'https://agent.example.ts.net', token: 'token', fetchImpl });
    if ([403, 404].includes(status)) {
      assert.deepEqual(plain(await client.models()), [{ id: 'compat', provider: 'hermes' }]);
      assert.equal(seen.length, 2);
    } else {
      await assert.rejects(client.models(), /Unavailable/);
      assert.equal(seen.length, 1);
    }
  }
});

test('toolsets parses read-only state and concrete tool names', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  assert.deepEqual(plain(await clientWith({ data: [
    { name: 'terminal', label: 'Terminal', enabled: true, configured: true, tools: ['terminal', null] },
    { name: 'browser', enabled: false, configured: false, tools: [] },
    { name: 'invalid' },
  ] }, seen).toolsets()), [
    { name: 'terminal', label: 'Terminal', enabled: true, configured: true, tools: ['terminal'] },
    { name: 'browser', enabled: false, configured: false, tools: [] },
  ]);
  assert.equal(seen[0]?.url, 'https://agent.example.ts.net/v1/toolsets');
  assert.equal(seen[0]?.init?.method, undefined);
  await assert.rejects(clientWith({}).toolsets(), /toolsets response was invalid/);
});

test('session detail reads the persisted model and verifies the session identity', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const session = await clientWith({ session: { id: 'a/b', model: 'locked' } }, seen).session('a/b');
  assert.equal(session.model, 'locked');
  assert.equal(Object.hasOwn(session, 'settledAt'), false);
  assert.equal(Object.hasOwn(session, 'autoSettleDisabled'), false);
  assert.equal(seen[0]?.url, 'https://agent.example.ts.net/api/sessions/a%2Fb');
  await assert.rejects(clientWith({ session: { id: 'other' } }).session('a'), /different thread/);
});

test('model locks send model and provider and require backend acceptance', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const response = { session_id: 'a/b', runtime: { model: 'shared', provider: 'alpha', model_lock: 'accepted' } };
  const client = clientWith(response, seen);
  assert.deepEqual(plain(await client.setSessionModel('a/b', { id: 'shared', provider: 'alpha' })), { sessionId: 'a/b', model: 'shared', provider: 'alpha' });
  assert.equal(seen[0]?.url, 'https://agent.example.ts.net/api/sessions/a%2Fb/model');
  assert.equal(seen[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), { model: 'shared', provider: 'alpha' });
  await client.setSessionModel('a/b', { id: 'alias', provider: 'hermes' });
  assert.deepEqual(JSON.parse(String(seen[1]?.init?.body)), { model: 'alias' });
  const missingProvider = clientWith({ ...response, runtime: { model: 'shared', model_lock: 'accepted' } });
  assert.equal((await missingProvider.setSessionModel('a/b', { id: 'shared', provider: 'beta' })).provider, 'beta');
  for (const body of [{}, { ...response, session_id: 'other' }, { ...response, runtime: { model: 'shared' } }]) {
    await assert.rejects(clientWith(body).setSessionModel('a/b', { id: 'shared' }), /did not confirm/);
  }
});

test('model locks explain why the compatibility gateway alias cannot be locked', async () => {
  const client = new HermesClient({ endpoint: 'https://agent.example.ts.net', token: 'token', fetchImpl: (async () =>
    new Response(JSON.stringify({ error: { code: 'missing_model' } }), { status: 400 })) as typeof fetch });
  await assert.rejects(client.setSessionModel('a', { id: 'hermes-agent', provider: 'hermes' }), /cannot lock its gateway default/);
});

test('a restored thread model lock remains in every run request', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const client = new HermesClient({ endpoint: 'https://agent.example.ts.net', token: 'token', fetchImpl: (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(url.endsWith('/model')
      ? { session_id: 'thread', runtime: { model: 'chosen', provider: 'alpha', model_lock: 'accepted' } }
      : { run_id: 'run', status: 'started', session_id: 'thread' }));
  }) as typeof fetch });
  const lock = await client.setSessionModel('thread', { id: 'chosen', provider: 'alpha' });
  const restored = parseSelectedModel(JSON.parse(JSON.stringify({ id: lock.model, provider: lock.provider })));
  await client.startRun('[QA] first', { sessionId: 'thread' }, restored);
  await client.startRun('[QA] next', { sessionId: 'thread' }, restored);
  for (const request of seen.slice(1)) {
    assert.equal(request.url, 'https://agent.example.ts.net/v1/runs');
    assert.deepEqual(JSON.parse(String(request.init?.body)), { input: request === seen[1] ? '[QA] first' : '[QA] next', session_id: 'thread', model: 'chosen', provider: 'alpha' });
  }
  await client.startRun('[QA] default', { sessionId: 'untouched' }, parseSelectedModel(null));
  assert.deepEqual(JSON.parse(String(seen[3]?.init?.body)), { input: '[QA] default', session_id: 'untouched' });
  await client.startRun('[QA] provider unknown', { sessionId: 'thread' }, { id: 'chosen' });
  assert.deepEqual(JSON.parse(String(seen[4]?.init?.body)), { input: '[QA] provider unknown', session_id: 'thread', model: 'chosen' });
});

test('saved thread selections reject malformed data and the compatibility owner is omitted from runs', async () => {
  for (const value of [{}, { id: '' }, { id: 'chosen', provider: 3 }]) assert.throws(() => parseSelectedModel(value), /Saved thread model is invalid/);
  const seen: { url?: string; init?: RequestInit }[] = [];
  await clientWith({ run_id: 'run', status: 'started' }, seen).startRun('[QA] default', { model: 'hermes-agent', provider: 'hermes' });
  assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), { input: '[QA] default', model: 'hermes-agent' });
});

test('steer posts text to the active run and requires acceptance', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const client = clientWith({ run_id: 'a/b', accepted: true }, seen);
  const controller = new AbortController();
  await client.steerRun('a/b', '[QA] stop at 5', controller.signal);
  assert.equal(seen[0]?.init?.signal, controller.signal);
  assert.equal(seen[0]?.url, 'https://agent.example.ts.net/v1/runs/a%2Fb/steer');
  assert.equal(seen[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), { input: '[QA] stop at 5' });
  await assert.rejects(client.steerRun('a/b', ' '), /cannot be empty/);
  assert.equal(seen.length, 1);
  for (const body of [{ run_id: 'a/b', accepted: false }, { run_id: 'other', accepted: true }, {}]) {
    await assert.rejects(clientWith(body).steerRun('a/b', 'stop'), /did not accept/);
  }
});

test('deleteSession issues DELETE against the session path', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  await clientWith({}, seen).deleteSession('abc/def');
  assert.equal(seen[0]?.url, 'https://agent.example.ts.net/api/sessions/abc%2Fdef');
  assert.equal(seen[0]?.init?.method, 'DELETE');
});

test('setPinned issues PATCH with the pinned flag', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  await clientWith({}, seen).setPinned('abc', true);
  assert.equal(seen[0]?.url, 'https://agent.example.ts.net/api/sessions/abc');
  assert.equal(seen[0]?.init?.method, 'PATCH');
  assert.equal((seen[0]?.init as RequestInit & { body: string })?.body, JSON.stringify({ pinned: true }));
});

test('forkSession posts to the fork route and reads the branched session', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const forked = await clientWith({ session: { id: 'branched' } }, seen).forkSession('abc');
  assert.equal(seen[0]?.url, 'https://agent.example.ts.net/api/sessions/abc/fork');
  assert.equal(seen[0]?.init?.method, 'POST');
  assert.equal(forked.id, 'branched');
});

test('inbox reads settled and config state and PATCHes config opt-outs', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const client = clientWith({ settled: { a: 10 }, config: { a: { auto_settle: false }, broken: 'x' } }, seen);
  assert.deepEqual(plain(await client.inbox()), { settled: { a: 10 }, config: { a: { auto_settle: false } } });
  assert.equal(seen[0]?.init?.method, undefined);
  await client.inbox({ a: 10 }, false, { b: { auto_settle: true } });
  assert.equal(seen[1]?.init?.method, 'PATCH');
  assert.deepEqual(JSON.parse((seen[1]?.init as RequestInit & { body: string })?.body), { settled: { a: 10 }, importOnly: false, config: { b: { auto_settle: true } } });
  // An old connector without /v1/inbox still yields empty state on GET.
  const legacy = new HermesClient({ endpoint: 'https://agent.example.ts.net', token: 'token', fetchImpl: (async () => ({ ok: false, status: 404, json: async () => undefined })) as unknown as typeof fetch });
  assert.deepEqual(plain(await legacy.inbox()), { settled: {}, config: {} });
});

test('sessions merge settled timestamps and auto-settle config onto the rows', async () => {
  const fetchImpl = (async (url: string) => ({
    ok: true,
    json: async () => String(url).endsWith('/v1/inbox')
      ? { settled: { a: 10 }, config: { a: { auto_settle: false } } }
      : { data: [{ id: 'a', title: 'A', pinned: true }, { id: 'b', title: 'B' }] },
  })) as unknown as typeof fetch;
  const merged = await new HermesClient({ endpoint: 'https://agent.example.ts.net', token: 'token', fetchImpl }).sessions();
  assert.deepEqual(plain(merged), [
    { id: 'a', title: 'A', pinned: true, settledAt: 10, autoSettleDisabled: true },
    { id: 'b', title: 'B' },
  ]);
});


test('replayed session creation recovers only the matching session_exists conflict', async () => {
  const seen: string[] = [];
  let returnedId = 'queued-thread';
  let code = 'session_exists';
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push(url);
    return init?.method === 'POST'
      ? { ok: false, status: 409, json: async () => ({ error: { code } }) }
      : { ok: true, json: async () => ({ session: { id: returnedId } }) };
  }) as unknown as typeof fetch;
  const client = new HermesClient({ endpoint: 'https://agent.example.ts.net', token: 'token', fetchImpl });
  assert.equal((await client.createSession({ id: 'queued-thread' })).id, 'queued-thread');
  assert.equal(seen.at(-1), 'https://agent.example.ts.net/api/sessions/queued-thread');
  returnedId = 'other-thread';
  await assert.rejects(client.createSession({ id: 'queued-thread' }), /different thread/);
  code = 'another_conflict';
  const before = seen.length;
  await assert.rejects(client.createSession({ id: 'queued-thread' }));
  assert.equal(seen.length, before + 1);
});
