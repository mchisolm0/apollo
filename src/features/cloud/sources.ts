import type { Source } from '../../../cloud/src/contract.ts';
import type { RelayPalette } from '../relay/theme.ts';

type SourceStyle = {
  label: string;
  /** SF Symbol on iOS, Material Symbol elsewhere. */
  symbol: { ios: string; android: string };
  /** Fixed hue for the glyph; `undefined` follows the theme accent. */
  hue?: `#${string}`;
};

/** How each producer is drawn: a Mail-style round glyph in the source's own hue. */
export const SOURCE_STYLES = {
  morning: { label: 'Morning', symbol: { ios: 'sun.max.fill', android: 'wb_sunny' }, hue: '#f3b842' },
  preview: { label: 'Preview', symbol: { ios: 'eye.fill', android: 'visibility' }, hue: '#7fb4ff' },
  fleet: { label: 'Fleet', symbol: { ios: 'server.rack', android: 'dns' }, hue: '#69d391' },
  digest: { label: 'Digest', symbol: { ios: 'chart.bar.fill', android: 'bar_chart' }, hue: '#c39bff' },
  jobs: { label: 'Jobs', symbol: { ios: 'briefcase.fill', android: 'work' }, hue: '#ff8a95' },
  hermes: { label: 'Hermes', symbol: { ios: 'bolt.fill', android: 'bolt' } },
  feedback: { label: 'Feedback', symbol: { ios: 'bubble.left.and.text.bubble.right.fill', android: 'forum' }, hue: '#5fd4d0' },
} as const satisfies Record<Source, SourceStyle>;

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** `amount` of `top` over `base`, as hex. */
export function mixHex(top: string, base: string, amount: number): string {
  const a = channels(top);
  const b = channels(base);
  return `#${a.map((channel, index) => Math.round(channel * amount + b[index] * (1 - amount)).toString(16).padStart(2, '0')).join('')}`;
}

// Strong enough to stand out from every theme's background, quiet enough to stay a tint.
const TINT = 0.24;

/** Glyph colors for a source in the active theme: the hue on a tint of it over the background. */
export function glyphColors(source: Source, palette: Pick<RelayPalette, 'background' | 'cyan'>) {
  const style: SourceStyle = SOURCE_STYLES[source];
  const hue = style.hue ?? palette.cyan;
  return { background: mixHex(hue, palette.background, TINT), foreground: hue };
}
