import { useState } from 'react';
import { useDidHide, useDidShow } from '@tarojs/taro';

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

/**
 * One 1-second interval for every ticking component. A list of unpaid orders shows a countdown
 * per card: with one timer each, every card's tick was its own render and its own `setData` to
 * the view layer; on one shared timer the ticks land in the same task, React batches them, and
 * the page sends one `setData` a second. The interval stops when the last listener leaves.
 */
export function onEverySecond(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => {
    for (const each of [...listeners]) each();
  }, 1000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * Whether the page this component is on is showing. A page under the one on top (or a tab page
 * switched away from) stays mounted; its timers would keep rendering into a view no one sees.
 */
export function usePageShown(): boolean {
  const [shown, setShown] = useState(true);
  useDidShow(() => setShown(true));
  useDidHide(() => setShown(false));
  return shown;
}
