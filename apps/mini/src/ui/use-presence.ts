import { useEffect, useState } from 'react';
import { useOverlayStore } from './overlay-store';

/** How long the exit animation runs (design.md §6: 150 ms out). */
export const EXIT_MS = 150;
/** How long the enter animation runs (design.md §6: 200 ms in). */
export const ENTER_MS = 200;

/**
 * Mount / animate / unmount for an overlay: `mounted` stays true through the exit animation,
 * `shown` flips one frame after mounting so the enter transition runs, and `settled` once it has
 * run. While shown, the page behind stops scrolling (overlay-store).
 *
 * Both are derived from `visible` plus state the timers set, never set while rendering: the H5
 * build (react-dom 18, production) dropped one of two render-phase updates here, so a sheet that
 * started hidden never opened there.
 */
export function usePresence(visible: boolean): {
  mounted: boolean;
  shown: boolean;
  settled: boolean;
} {
  // Set by the timers only: whether the overlay is still on screen after `visible` went false
  // (the exit animation), and whether the enter transition has started, and finished.
  const [present, setPresent] = useState(visible);
  const [entered, setEntered] = useState(false);
  const [settled, setSettled] = useState(false);
  const push = useOverlayStore((state) => state.push);
  const pop = useOverlayStore((state) => state.pop);

  useEffect(() => {
    if (!visible) {
      const timer = setTimeout(() => {
        setPresent(false);
        setEntered(false);
        setSettled(false);
      }, EXIT_MS);
      return () => clearTimeout(timer);
    }
    const enter = setTimeout(() => {
      setPresent(true);
      setEntered(true);
    }, 16);
    const settle = setTimeout(() => setSettled(true), 16 + ENTER_MS);
    return () => {
      clearTimeout(enter);
      clearTimeout(settle);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    push();
    return () => pop();
  }, [visible, push, pop]);

  return { mounted: visible || present, shown: visible && entered, settled: visible && settled };
}
