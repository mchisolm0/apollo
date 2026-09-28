export type ThemeId = 'code' | 'chat' | 'grove' | 'ocean' | 'ember' | 'iris';

export type RelayTheme = { id: ThemeId; label: string; accent: string };

export const THEME_STORAGE_KEY = 'ekho:theme';

/** Accent-carrying colors only; every other dark surface color stays fixed. */
export const THEMES: RelayTheme[] = [
  { id: 'code', label: 'Code', accent: '#a7c8ff' },
  { id: 'chat', label: 'Chat', accent: '#f2b8d0' },
  { id: 'grove', label: 'Grove', accent: '#b3e0c0' },
  { id: 'ocean', label: 'Ocean', accent: '#8fc3ea' },
  { id: 'ember', label: 'Ember', accent: '#f3c39a' },
  { id: 'iris', label: 'Iris', accent: '#c3aef2' },
];

const themeMap = new Map(THEMES.map((theme) => [theme.id, theme]));

export function parseTheme(value: string | null | undefined): ThemeId {
  return themeMap.has(value as ThemeId) ? (value as ThemeId) : 'code';
}

type RelayColorSet = Record<'cyan', string> & Record<string | number | symbol, unknown>;

export function applyTheme<T extends RelayColorSet>(base: T, id: ThemeId): T {
  if (id === 'code') return base;
  return { ...base, cyan: themeMap.get(id)!.accent };
}
