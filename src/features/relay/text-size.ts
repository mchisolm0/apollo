// Reading text size and terminal/code font size. Pure helpers so storage
// parsing is testable outside react-native.
export const TEXT_SIZE_MIN = 14;
export const TEXT_SIZE_MAX = 22;
export const TEXT_SIZE_DEFAULT = 17;
export const CODE_SIZE_MIN = 10;
export const CODE_SIZE_MAX = 18;
export const CODE_SIZE_DEFAULT = 13;
export const TEXT_SIZE_STORAGE_KEY = 'ekho:text-scale';
export const CODE_SIZE_STORAGE_KEY = 'ekho:code-text-size';
export const CODE_CUSTOM_STORAGE_KEY = 'ekho:code-text-custom';

/** App text size and Dynamic Type combine when deciding whether rows need more room. */
export function isLargeText(fontScale: number, factor: number): boolean {
  return fontScale * factor > 1.2;
}

// Legacy Small/Default/Large stored values map onto the pt slider.
const LEGACY_SCALE_SIZES = { small: 14, default: 17, large: 20 } as const;

export function clampSize(pt: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(pt)));
}

export function parseTextSize(value: unknown): number {
  if (value === 'small' || value === 'default' || value === 'large') return LEGACY_SCALE_SIZES[value];
  return parsePt(value, TEXT_SIZE_DEFAULT, TEXT_SIZE_MIN, TEXT_SIZE_MAX);
}

export function parseCodeSize(value: unknown): number {
  return parsePt(value, CODE_SIZE_DEFAULT, CODE_SIZE_MIN, CODE_SIZE_MAX);
}

export function parseEnabled(value: unknown): boolean {
  return value === '1' || value === 'true';
}

function parsePt(value: unknown, fallback: number, min: number, max: number): number {
  const pt = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(pt)) return fallback;
  return clampSize(pt, min, max);
}
