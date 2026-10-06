export type ThemeId = 'code' | 'chat' | 'grove' | 'ocean' | 'ember' | 'iris';

export type RelayPalette = Record<
  'background'
  | 'chrome'
  | 'surface'
  | 'elevated'
  | 'composer'
  | 'selectedThread'
  | 'userBubble'
  | 'line'
  | 'lineStrong'
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'cyan'
  | 'accentForeground'
  | 'amber'
  | 'red'
  | 'green'
  | 'warningSurface'
  | 'dangerSurface'
  | 'codeBackground'
  | 'codeText'
  | 'diffInsert'
  | 'diffDelete'
  | 'backdrop'
  | 'shadow',
  string
>;

export const THEME_STORAGE_KEY = 'apollo:theme';

export const THEME_PALETTES = {
  code: {
    background: '#000000',
    chrome: '#000000',
    surface: '#1c1c1e',
    elevated: '#222224',
    composer: '#1c1d22',
    selectedThread: '#25262c',
    userBubble: '#1c1c1e',
    line: '#292929',
    lineStrong: '#38383a',
    primary: '#ffffff',
    secondary: '#aaaaaa',
    muted: '#929298',
    cyan: '#a7c8ff',
    accentForeground: '#101725',
    amber: '#f3b842',
    red: '#ff5363',
    green: '#69d391',
    warningSurface: '#2c2412',
    dangerSurface: '#2c1619',
    codeBackground: '#151517',
    codeText: '#e8e8ed',
    diffInsert: '#183d2b',
    diffDelete: '#491e25',
    backdrop: 'rgba(0, 0, 0, 0.72)',
    shadow: 'rgba(0, 0, 0, 0.4)',
  },
  chat: {
    background: '#140c11',
    chrome: '#190f15',
    surface: '#281a22',
    elevated: '#31212b',
    composer: '#2a1923',
    selectedThread: '#3c2432',
    userBubble: '#35212c',
    line: '#412c37',
    lineStrong: '#604052',
    primary: '#fff5f9',
    secondary: '#cfb5c2',
    muted: '#bca2b0',
    cyan: '#f48db6',
    accentForeground: '#2a101d',
    amber: '#f3b842',
    red: '#ff5363',
    green: '#69d391',
    warningSurface: '#2c2412',
    dangerSurface: '#2c1619',
    codeBackground: '#281a22',
    codeText: '#fff5f9',
    diffInsert: '#183d2b',
    diffDelete: '#491e25',
    backdrop: 'rgba(0, 0, 0, 0.72)',
    shadow: 'rgba(0, 0, 0, 0.4)',
  },
  grove: {
    background: '#0b130f',
    chrome: '#101a14',
    surface: '#19291f',
    elevated: '#213329',
    composer: '#192d22',
    selectedThread: '#294433',
    userBubble: '#233b2b',
    line: '#304b3b',
    lineStrong: '#466951',
    primary: '#f2fff5',
    secondary: '#b5cbbc',
    muted: '#9fb6a7',
    cyan: '#79db9c',
    accentForeground: '#0c2415',
    amber: '#f3b842',
    red: '#ff5363',
    green: '#69d391',
    warningSurface: '#2c2412',
    dangerSurface: '#2c1619',
    codeBackground: '#19291f',
    codeText: '#f2fff5',
    diffInsert: '#183d2b',
    diffDelete: '#491e25',
    backdrop: 'rgba(0, 0, 0, 0.72)',
    shadow: 'rgba(0, 0, 0, 0.4)',
  },
  ocean: {
    background: '#081318',
    chrome: '#0c1b22',
    surface: '#142932',
    elevated: '#1b3440',
    composer: '#142d38',
    selectedThread: '#224554',
    userBubble: '#1b3a47',
    line: '#294955',
    lineStrong: '#3b6675',
    primary: '#f0fcff',
    secondary: '#afc8d0',
    muted: '#9ab3be',
    cyan: '#55d6d0',
    accentForeground: '#072521',
    amber: '#f3b842',
    red: '#ff5363',
    green: '#69d391',
    warningSurface: '#2c2412',
    dangerSurface: '#2c1619',
    codeBackground: '#142932',
    codeText: '#f0fcff',
    diffInsert: '#183d2b',
    diffDelete: '#491e25',
    backdrop: 'rgba(0, 0, 0, 0.72)',
    shadow: 'rgba(0, 0, 0, 0.4)',
  },
  ember: {
    background: '#180e09',
    chrome: '#20140d',
    surface: '#2e2017',
    elevated: '#38281c',
    composer: '#322116',
    selectedThread: '#493020',
    userBubble: '#3e291b',
    line: '#503827',
    lineStrong: '#735038',
    primary: '#fff8ef',
    secondary: '#d3bda8',
    muted: '#bda791',
    cyan: '#ffab66',
    accentForeground: '#2c1708',
    amber: '#f3b842',
    red: '#ff5363',
    green: '#69d391',
    warningSurface: '#2c2412',
    dangerSurface: '#2c1619',
    codeBackground: '#2e2017',
    codeText: '#fff8ef',
    diffInsert: '#183d2b',
    diffDelete: '#491e25',
    backdrop: 'rgba(0, 0, 0, 0.72)',
    shadow: 'rgba(0, 0, 0, 0.4)',
  },
  iris: {
    background: '#110c1b',
    chrome: '#191124',
    surface: '#261b35',
    elevated: '#302242',
    composer: '#291c39',
    selectedThread: '#3d2b55',
    userBubble: '#332348',
    line: '#453159',
    lineStrong: '#61467d',
    primary: '#fbf6ff',
    secondary: '#c7b9dd',
    muted: '#b2a3c8',
    cyan: '#bf96ff',
    accentForeground: '#211235',
    amber: '#f3b842',
    red: '#ff5363',
    green: '#69d391',
    warningSurface: '#2c2412',
    dangerSurface: '#2c1619',
    codeBackground: '#261b35',
    codeText: '#fbf6ff',
    diffInsert: '#183d2b',
    diffDelete: '#491e25',
    backdrop: 'rgba(0, 0, 0, 0.72)',
    shadow: 'rgba(0, 0, 0, 0.4)',
  },
} satisfies Record<ThemeId, RelayPalette>;

export const THEMES = [
  { id: 'code', label: 'Code' },
  { id: 'chat', label: 'Chat' },
  { id: 'grove', label: 'Grove' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'ember', label: 'Ember' },
  { id: 'iris', label: 'Iris' },
] satisfies { id: ThemeId; label: string }[];

export function parseTheme(value: string | null | undefined): ThemeId {
  return THEMES.find((theme) => theme.id === value)?.id ?? 'code';
}
