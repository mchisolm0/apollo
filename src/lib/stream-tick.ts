/** The streaming reply last seen, and when it last ticked. `null` once seen with nothing streaming. */
export type StreamTickState = { readonly id: string; readonly length: number; readonly tickedAt: number } | null;

/** Text growth ticks at most this often, so a fast stream reads as a light rhythm rather than a buzz. */
export const STREAM_TICK_MS = 320;

/**
 * Decides whether a streaming reply should tick. A new reply ticks at once, growth is throttled,
 * and the first look (`last` undefined) only records state, so opening a thread mid-reply waits a full
 * throttle window before its first tick.
 */
export function streamTick(last: StreamTickState | undefined, streaming: { readonly id: string; readonly length: number } | undefined, now: number): { readonly state: StreamTickState; readonly tick: boolean } {
  if (!streaming) return { state: null, tick: false };
  if (last === undefined) return { state: { ...streaming, tickedAt: now }, tick: false };
  const tick = last?.id !== streaming.id || (streaming.length > last.length && now - last.tickedAt >= STREAM_TICK_MS);
  return { state: { ...streaming, tickedAt: tick ? now : last?.tickedAt ?? 0 }, tick };
}
