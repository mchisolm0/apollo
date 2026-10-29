import { Stack } from 'expo-router';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { useMemo } from 'react';
import { Platform } from 'react-native';
import type { HeaderBarButtonMailSearchToolbarItem } from 'react-native-screens';

export const HAS_MAIL_TOOLBAR = Platform.OS === 'ios' && isLiquidGlassAvailable();
export const MAIL_TOOLBAR_INSET = 56;

/** Expo Router 58 passes these typed props directly to the patched native header. */
export function MailToolbar({ attentionOnly, onFilter, onCompose, onSearch }: {
  attentionOnly: boolean;
  onFilter: () => void;
  onCompose: () => void;
  onSearch: (query: string) => void;
}) {
  // Native owns the text; a delayed JS echo can overwrite newer keystrokes.
  const item = useMemo<HeaderBarButtonMailSearchToolbarItem>(() => ({
    type: 'mailSearchToolbar',
    placeholder: 'Search',
    useFallbackSearchField: true,
    showsSearchDismissButton: true,
    filterButtonId: 'apollo-filter',
    filterSystemImageName: attentionOnly ? 'line.3.horizontal.decrease.circle.fill' : 'line.3.horizontal.decrease',
    composeButtonId: 'apollo-compose',
    searchTextChangeId: 'apollo-search',
    onFilterPress: onFilter,
    onComposePress: onCompose,
    onSearchTextChange: onSearch,
  }), [attentionOnly, onFilter, onCompose, onSearch]);
  return HAS_MAIL_TOOLBAR ? <Stack.Screen options={{ unstable_nativeProps: { headerConfig: { headerToolbarItems: [item] } } }} /> : null;
}
