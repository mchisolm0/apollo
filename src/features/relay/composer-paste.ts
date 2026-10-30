/**
 * Text pastes at least this many characters (UTF-16, like the draft limit) become a `.txt`
 * attachment instead of draft text. T3 uses 32 KB; Apollo's draft holds 8000 characters, so a paste
 * that would not fit is folded too.
 */
export const MAX_DRAFT_CHARS = 8000;
export const PASTED_TEXT_ATTACHMENT_CHARS = MAX_DRAFT_CHARS;

/** Stable, readable names when a draft holds several folded pastes. */
export function pastedTextFileName(existingNames: readonly string[]): string {
  const names = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!names.has('pasted-text.txt')) return 'pasted-text.txt';
  for (let sequence = 2; ; sequence += 1) {
    const candidate = `pasted-text-${sequence}.txt`;
    if (!names.has(candidate)) return candidate;
  }
}
