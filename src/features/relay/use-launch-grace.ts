import { useEffect, useState } from 'react';

const LAUNCHED_AT = Date.now();

/** Startup quiet period: a normal connect finishes inside it, so transient states never flash. */
export const LAUNCH_GRACE_MS = 2_000;

/** True once `ms` have passed since the JavaScript bundle started. */
export function useLaunchGrace(ms = LAUNCH_GRACE_MS): boolean {
  const [over, setOver] = useState(() => Date.now() - LAUNCHED_AT >= ms);
  useEffect(() => {
    if (over) return;
    const timer = setTimeout(() => setOver(true), Math.max(0, LAUNCHED_AT + ms - Date.now()));
    return () => clearTimeout(timer);
  }, [over, ms]);
  return over;
}
