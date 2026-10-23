import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { Children, isValidElement, type ReactNode } from 'react';
import ts from 'typescript';

// Exercise screen callbacks and rendered results without native modules or a simulator.
function screenFixture(path: string, exportName: string, imports: Record<string, unknown> = {}) {
  const slots = new Map<number, unknown>();
  let cursor = 0;
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, (props: Record<string, unknown>) => ReactNode> = {};
  runInNewContext(source, {
    exports,
    require: (id: string) => {
      if (id in imports) return imports[id];
      if (id === 'react/jsx-runtime') return { jsx: (type: string, props: unknown) => ({ type, props, $$typeof: Symbol.for('react.transitional.element') }), jsxs: (type: string, props: unknown) => ({ type, props, $$typeof: Symbol.for('react.transitional.element') }) };
      if (id === 'react') return {
        useState: (initial: unknown) => {
          const index = cursor++;
          if (!slots.has(index)) slots.set(index, initial);
          return [slots.get(index), (value: unknown) => slots.set(index, value)];
        },
        useRef: () => ({ current: null }), useEffect() {}, useCallback: (fn: unknown) => fn,
      };
      if (id === 'react-native') return { StyleSheet: { create: (value: unknown) => value }, Platform: { OS: 'ios' }, View: 'View', Text: 'Text', ScrollView: 'ScrollView', Pressable: 'Pressable', KeyboardAvoidingView: 'KeyboardAvoidingView' };
      if (id === 'react-native-safe-area-context') return { SafeAreaView: 'SafeAreaView' };
      if (id.endsWith('relay-ui')) return { RelayHeader: 'RelayHeader', RelayButton: 'RelayButton', RelayInput: 'RelayInput', useThemedStyles: () => ({}), useRelayStyles: () => ({}), useColors: () => ({}), ConnectionMark: 'ConnectionMark', connectionLabels: { connected: 'Connected', offline: 'Offline' } };
      if (id === './settings-ui') return { SettingsHeader: 'SettingsHeader', SettingSection: 'SettingSection', SettingRow: 'SettingRow' };
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  return (props: Record<string, unknown> = {}) => {
    cursor = 0;
    const nodes: ReactNode[] = [];
    const visit = (node: ReactNode) => {
      Children.forEach(node, (child) => {
        nodes.push(child);
        if (isValidElement<{ children?: ReactNode }>(child)) visit(child.props.children);
      });
    };
    visit(exports[exportName](props));
    const elements = nodes.filter(isValidElement<{
      children?: ReactNode; accessibilityLabel?: string; value?: string; disabled?: boolean;
      onPress?: () => void; onChangeText?: (value: string) => void; onBack?: () => void;
    }>);
    return {
      find: (label: string) => {
        const node = elements.find((node) => node.props.accessibilityLabel === label)
          ?? elements.find((node) => node.props.onPress && (node.props.children === label || isValidElement<{ children?: ReactNode }>(node.props.children) && node.props.children.props.children === label))
          ?? elements.find((node) => node.type === label || node.props.children === label);
        assert.ok(node, `Missing ${label}`);
        return node.props;
      },
      text: nodes.filter((node) => typeof node === 'string').join(' '),
    };
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('pairing paste fills the field without submitting, with empty and denied clipboard fallback', async () => {
  for (const value of [' apollo://pair?host=example#token=one ', '', new Error('Denied')]) {
    let submissions = 0;
    const render = screenFixture('./pairing-screen.tsx', 'PairingScreen', {
      'expo-clipboard': { getStringAsync: async () => { if (value instanceof Error) throw value; return value; } },
    });
    const props = { onManualSubmit: () => submissions++, onCancel: () => {}, onConfirm: () => {} };
    assert.equal(render(props).find('RelayHeader').onBack, undefined);
    render(props).find('Paste pairing link').onPress!();
    await flush();
    assert.equal(render(props).find('Pairing link').value, typeof value === 'string' ? value.trim() : '');
    assert.equal(submissions, 0);
    assert.equal(render({ ...props, state: 'confirm', pairing: { endpoint: 'https://agent', hostname: 'Agent' } }).find('RelayHeader').onBack, props.onCancel);
  }
});

test('share back and successful discard return to inbox, failed discard stays on screen', async () => {
  const destinations: string[] = [];
  let fail = false;
  const render = screenFixture('../../app/share.tsx', 'default', {
    'expo-router': { useRouter: () => ({ dismissTo: (path: string) => destinations.push(path) }), useFocusEffect() {} },
    '@/lib': { useApollo: () => ({ agents: [], runtime: {} }) },
    '@/features/sharing': { useIncomingShares: () => ({ pendingShares: [{ id: 'share', text: 'Text', attachments: [] }], refresh() {}, discardShare: async () => { if (fail) throw new Error('Disk full'); } }) },
  });
  render().find('Go back').onPress!();
  render().find('Discard selected share').onPress!();
  await flush();
  assert.deepEqual(destinations, ['/', '/']);
  fail = true;
  render().find('Discard selected share').onPress!();
  await flush();
  assert.equal(destinations.length, 2);
});

test('agent settings shows the connection result and saves an edited name', async () => {
  const render = screenFixture('./agent-settings-screen.tsx', 'AgentSettingsScreen');
  const names: string[] = [];
  const agent = { name: 'Mac-Mini.local', connection: 'connected', endpoint: 'https://agent' };
  const props = { agent, onTestConnection: async () => {}, onRename: async (name: string) => { names.push(name); } };
  render(props).find('Test connection').onPress!();
  assert.match(render(props).text, /Testing/);
  await flush();
  assert.match(render(props).text, /Connected/);
  assert.match(render({ ...props, agent: { ...agent, connection: 'offline' }, connectionError: 'Timed out' }).text, /Timed out/);
  render(props).find('Agent name').onChangeText!('  Studio  ');
  render(props).find('Save').onPress!();
  await flush();
  assert.deepEqual(names, ['Studio']);
  render(props).find('Agent name').onChangeText!('   ');
  assert.equal(render(props).find('Save').disabled, true);
});
