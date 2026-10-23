import { useThemedStyles, useColors, type RelayPalette } from './relay-ui';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { LegendList } from '@legendapp/list/react-native';


import type { HermesModel } from '../../lib/types';

export interface ModelPickerProps {
  models: readonly HermesModel[];
  /** Hermes-advertised default (capabilities.model). Rendered as a Default badge; never hardcoded. */
  defaultModel?: string;
  selected?: string;
  selectedProvider?: string;
  disabled?: boolean;
  loading?: boolean;
  onSelect(model: HermesModel): void;
}

type Row = { kind: 'group'; id: string; title: string } | { kind: 'model'; id: string; model: HermesModel };

/** Hermes's compatibility id selects the agent default, rather than a particular model. */
export function modelDisplayName(model: Pick<HermesModel, 'id' | 'label'>): string {
  return model.id === 'hermes-agent' ? 'Default' : model.label?.trim() || model.id;
}

/** Bottom-sheet-friendly model list. Renders only what the server returns; empty state when none. */
export function ModelPicker({ models, defaultModel, selected, selectedProvider, disabled = false, loading = false, onSelect }: ModelPickerProps) {
  const styles = useThemedStyles(createStyles);
  const colors = useColors();
  const [query, setQuery] = useState('');
  const currentId = selected ?? defaultModel ?? models.find((model) => model.default)?.id;
  const matches = models.filter((model) => model.id === currentId && (!selectedProvider || model.provider === selectedProvider));
  const currentProvider = selectedProvider ?? matches.find((model) => model.default)?.provider ?? (matches.length === 1 ? matches[0].provider : undefined);
  const currentModel = matches.find((model) => model.provider === currentProvider) ?? { id: currentId ?? 'hermes-agent' };
  const search = query.trim().toLocaleLowerCase();
  const groups = new Map<string, HermesModel[]>();
  const choices = currentId && !models.some((model) => model.id === currentId && model.provider === currentProvider)
    ? [{ id: currentId, provider: currentProvider }, ...models] : models;
  for (const model of choices) {
    if (search && !`${model.id} ${modelDisplayName(model)} ${model.provider ?? ''}`.toLocaleLowerCase().includes(search)) continue;
    const group = model.provider?.trim() || 'Other';
    groups.set(group, [...(groups.get(group) ?? []), model]);
  }
  const rows = [...[...groups.entries()].sort(([a], [b]) => a.localeCompare(b))].flatMap(([title, items]): Row[] => [
    { kind: 'group', id: title, title },
    ...items.sort((a, b) => modelDisplayName(a).localeCompare(modelDisplayName(b), undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id))
      .map((model): Row => ({ kind: 'model', id: JSON.stringify([model.provider, model.id]), model })),
  ]);

  return (
    <View style={styles.container}>
      {currentId ? <Text style={{ color: colors.primary, fontSize: 13, paddingHorizontal: 16, paddingTop: 12 }}>Thread model: {modelDisplayName(currentModel)}</Text> : null}
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
            isDefault={item.model.default ?? item.model.id === defaultModel}
            isSelected={item.model.id === currentId && item.model.provider === currentProvider}
            disabled={disabled}
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

function ModelRow({ model, isDefault, isSelected, disabled, onSelect }: {
  model: HermesModel; isDefault: boolean; isSelected: boolean; disabled: boolean; onSelect: (model: HermesModel) => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Use model ${modelDisplayName(model)}${isDefault ? ', default' : ''}`}
      accessibilityState={{ selected: isSelected, disabled }}
      disabled={disabled}
      onPress={() => onSelect(model)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>{modelDisplayName(model)}</Text>
        {model.label && model.id !== 'hermes-agent' ? <Text style={styles.id} numberOfLines={1}>{model.id}</Text> : null}
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
