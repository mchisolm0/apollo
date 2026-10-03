import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { HermesToolset } from '../../lib/types';
import { useColors } from './relay-ui';
import { SettingsHeader } from './settings-ui';

export function ToolsetsScreen({ toolsets, loading, error, onRetry, onBack }: {
  toolsets: readonly HermesToolset[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  const colors = useColors();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  return <View style={{ flex: 1 }}>
    <SettingsHeader title="Toolsets" onBack={onBack} />
    <ScrollView contentContainerStyle={styles.content}>
      {loading ? <ActivityIndicator accessibilityLabel="Loading toolsets" color={colors.secondary} /> : null}
      {error ? <View accessibilityRole="alert">
        <Text style={[styles.detail, { color: colors.red }]}>{error}</Text>
        <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retry}><Text style={{ color: colors.cyan }}>Retry</Text></Pressable>
      </View> : null}
      {!loading && !error && !toolsets.length ? <Text style={{ color: colors.secondary }}>No toolsets available.</Text> : null}
      {toolsets.map((toolset) => {
        const open = expanded.has(toolset.name);
        return <View key={toolset.name} style={[styles.toolset, { borderBottomColor: colors.line }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${toolset.label ?? toolset.name}, ${toolset.enabled ? 'On' : 'Off'}, ${toolset.tools.length} tools`}
            accessibilityState={{ expanded: open }} style={styles.row} onPress={() => setExpanded((current) => {
              const next = new Set(current);
              if (next.has(toolset.name)) next.delete(toolset.name); else next.add(toolset.name);
              return next;
            })}>
            <Text style={[styles.name, { color: colors.primary }]}>{toolset.label ?? toolset.name}</Text>
            <Text style={{ color: colors.secondary }}>{toolset.enabled ? 'On' : 'Off'}</Text>
            <Text style={{ color: colors.secondary }}>{open ? '⌄' : '›'}</Text>
          </Pressable>
          {open ? <View style={styles.tools}>
            {!toolset.configured ? <Text style={[styles.detail, { color: colors.amber }]}>Not configured</Text> : null}
            {toolset.tools.length ? toolset.tools.map((tool) => <Text key={tool} selectable style={[styles.detail, { color: colors.secondary }]}>{tool}</Text>)
              : <Text style={[styles.detail, { color: colors.secondary }]}>No tools</Text>}
          </View> : null}
        </View>;
      })}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  toolset: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  name: { flex: 1, fontSize: 15 },
  tools: { paddingBottom: 12, gap: 6 },
  detail: { fontSize: 13, lineHeight: 18 },
  retry: { minHeight: 44, justifyContent: 'center' },
});
