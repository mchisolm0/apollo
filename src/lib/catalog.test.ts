import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import type { AgentCatalog } from './catalog';
import * as pairing from './pairing.ts';
import * as protocol from './protocol.ts';

// Keep native storage out of Node while exercising the catalog's real persistence.
test('device names survive catalog reloads and legacy records remain readable', async () => {
  const source = ts.transpileModule(readFileSync(new URL('./catalog.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { AgentCatalog?: typeof AgentCatalog } = {};
  runInNewContext(source, {
    exports,
    require: (id: string) => {
      if (id === './pairing') return pairing;
      if (id === './protocol') return protocol;
      if (id === '@react-native-async-storage/async-storage' || id === 'expo-secure-store') return {};
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  const Catalog = exports.AgentCatalog!;
  const legacy = { id: 'legacy', label: 'Agent', endpoint: { url: 'https://agent.example', transport: 'https' as const }, createdAt: 1 };
  let saved = JSON.stringify([legacy, { ...legacy, id: 'invalid-name', deviceName: 42 }]);
  const metadata = { getItem: async () => saved, setItem: async (_key: string, value: string) => { saved = value; }, removeItem: async () => {} };
  const catalog = new Catalog({ metadata });
  await catalog.load();
  assert.equal(catalog.get('legacy')?.deviceName, undefined);
  assert.equal(catalog.get('invalid-name')?.deviceName, undefined);
  await catalog.upsert({ ...legacy, id: 'paired', deviceName: 'Apollo QA 4' });
  await catalog.update('paired', { lastConnectedAt: 2 });
  const reloaded = new Catalog({ metadata });
  await reloaded.load();
  assert.equal(reloaded.get('paired')?.deviceName, 'Apollo QA 4');
  assert.equal(reloaded.get('paired')?.lastConnectedAt, 2);
  assert.equal(reloaded.get('legacy')?.deviceName, undefined);
});
