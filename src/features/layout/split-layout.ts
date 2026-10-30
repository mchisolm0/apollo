// Breakpoints follow T3 Code's mobile shell: available space decides, not device or orientation, so
// every iPhone stays single-pane in landscape while iPad windows split as they resize.
export const SPLIT_MIN_WIDTH = 720;
export const SPLIT_MIN_HEIGHT = 600;
const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_WIDTH = 380;

/** The thread list's width beside the open thread, or undefined when the window is too small to split. */
export function sidebarWidth({ width, height }: { width: number; height: number }): number | undefined {
  if (width < SPLIT_MIN_WIDTH || height < SPLIT_MIN_HEIGHT) return undefined;
  return Math.min(Math.max(Math.round(width * 0.32), SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH);
}

/**
 * How a sidebar pick reaches the detail pane. An open thread is replaced in place; the empty pane
 * pushes so the inbox stays beneath and a window shrinking to one pane still has a way back.
 */
export function sidebarOpenAction(pathname: string): 'push' | 'replace' {
  return pathname.startsWith('/session/') ? 'replace' : 'push';
}
