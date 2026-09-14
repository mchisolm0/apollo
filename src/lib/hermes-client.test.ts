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
    HermesClient?: new (options: { endpoint: string; token: string; fetchImpl?: typeof fetch }) => {
      models(): Promise<readonly HermesModel[]>;
      deleteSession(id: string): Promise<void>;
      setPinned(id: string, pinned: boolean): Promise<void>;
      forkSession(id: string): Promise<{ id: string }>;
    };
    parseModels?: (value: unknown) => readonly HermesModel[];
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

const { HermesClient, parseModels } = loadClient();
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

test('models() returns [] when the server shape is unknown', async () => {
  assert.deepEqual(plain(await clientWith({ unexpected: true }).models()), []);
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
