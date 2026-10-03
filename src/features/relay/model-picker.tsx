import { useThemedStyles, useColors, type RelayPalette } from './relay-ui';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { LegendList } from '@legendapp/list/react-native';


import type { HermesModel } from '../../lib/types';

export interface ModelPickerProps {
  models: readonly HermesModel[];
  /** Hermes-advertised default (capabilities.model). Rendered as a Default badge; never hardcoded. */
  defaultModel?: string;
  selected?: string;
  loading?: boolean;
  onSelect(modelId: string): void;
}

type Row = { kind: 'group'; id: string; title: string } | { kind: 'model'; id: string; model: HermesModel };

/** Bottom-sheet-friendly model list. Renders only what the server returns; empty state when none. */
export function ModelPicker({ models, defaultModel, selected, loading = false, onSelect }: ModelPickerProps) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const [query, setQuery] = useState('');
  const rows = useMemo<Row[]>(() => {
    const search = query.trim().toLocaleLowerCase();
    const groups = new Map<string, HermesModel[]>();
    for (const model of models) {
      if (search && !`${model.id} ${model.label ?? ''} ${model.provider ?? ''}`.toLocaleLowerCase().includes(search)) continue;
      const group = model.provider?.trim() || 'Other';
      groups.set(group, [...(groups.get(group) ?? []), model]);
    }
    return [...[...groups.entries()].sort(([a], [b]) => a.localeCompare(b))].flatMap(([title, items]): Row[] => [
      { kind: 'group', id: title, title },
      ...items.map((model): Row => ({ kind: 'model', id: model.id, model })),
    ]);
  }, [models, query]);

  return (
    <View style={styles.container}>
      <TextInput
        accessibilityLabel="Find a model"
        placeholder="Find a model"
        placeholderTextColor={colors.secondary}
        selectionColor={colors.cyan}
        value={query}
        onChangeText={setQuery}
        style={styles.search}
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
      />
      <LegendList
        style={styles.list}
        data={rows}
        recycleItems
        keyExtractor={(row) => `${row.kind}:${row.id}`}
        getItemType={(row) => row.kind}
        estimatedItemSize={52}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => item.kind === 'group'
          ? <Text style={styles.group}>{item.title}</Text>
          : <ModelRow
            model={item.model}
            isDefault={item.model.id === defaultModel || item.model.default === true}
            isSelected={item.model.id === (selected ?? defaultModel)}
            onSelect={onSelect}
          />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{loading ? 'Loading models' : 'No models available'}</Text>
            <Text style={styles.emptyText}>{loading ? 'Fetching the list from Hermes.' : query ? 'Try a different search.' : 'The server advertised no models.'}</Text>
          </View>
        }
      />
    </View>
  );
}

function ModelRow({ model, isDefault, isSelected, onSelect }: {
  model: HermesModel; isDefault: boolean; isSelected: boolean; onSelect: (id: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Use model ${model.label ?? model.id}${isDefault ? ', default' : ''}`}
      accessibilityState={{ selected: isSelected }}
      onPress={() => onSelect(model.id)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>{model.label ?? model.id}</Text>
        {model.label ? <Text style={styles.id} numberOfLines={1}>{model.id}</Text> : null}
      </View>
      {isDefault ? <Text style={styles.badge}>Default</Text> : null}
      {isSelected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
  );
}

const createStyles = (colors: RelayPalette) => StyleSheet.create({
  container: { maxHeight: 420 },
  search: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    color: colors.primary,
    fontSize: 15,
    margin: 12,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  list: { flexGrow: 0 },
  group: { color: colors.secondary, fontSize: 12, fontWeight: '600', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  pressed: { opacity: 0.6 },
  rowText: { flex: 1 },
  name: { color: colors.primary, fontSize: 15 },
  id: { color: colors.secondary, fontSize: 12, marginTop: 2 },
  badge: { backgroundColor: colors.elevated, borderRadius: 6, color: colors.cyan, fontSize: 12, fontWeight: '600', overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 3 },
  check: { color: colors.cyan, fontSize: 16, fontWeight: '700' },
  empty: { alignItems: 'center', padding: 24 },
  emptyTitle: { color: colors.primary, fontSize: 15, fontWeight: '600' },
  emptyText: { color: colors.secondary, fontSize: 13, marginTop: 4 },
});
