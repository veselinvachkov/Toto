import { useEffect, useRef } from 'react';

/**
 * Visibility-aware polling. Runs `fn` once immediately, then on an interval -
 * but ONLY while the tab is visible. Background tabs stop polling entirely and
 * resume (with an immediate refresh) when the user returns.
 *
 * At scale this is the difference between tens of thousands of idle background
 * tabs each hammering the RPC every interval, and zero load from anyone who
 * isn't actively looking at the page.
 */
export function usePolling(fn: () => void, intervalMs: number): void {
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const tick = () => saved.current();

    const start = () => {
      if (id === null) {
        tick(); // refresh immediately on (re)start
        id = setInterval(tick, intervalMs);
      }
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);
}
