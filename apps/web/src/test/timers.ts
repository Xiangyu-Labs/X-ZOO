import { afterAll } from 'vitest';

/**
 * Nothing a test file schedules outlives the file.
 *
 * The unit suite runs under happy-dom, but vitest only lifts DOM names onto the
 * global: `setTimeout`, `setInterval` and `setImmediate` stay Node's. Every
 * component file leaves some of them pending when its last test ends (antd's
 * motion and debounce timers, React's scheduler, which drives itself through
 * `setImmediate`): `diy/panels` leaves ~160, `product-editor` 12,
 * `virtual-cards` 8. The environment is torn down in the worker's stop path
 * (`window`, `document` and the rest deleted from the global) while vitest's
 * `uncaughtException` listener is still installed. A leftover that fires
 * after that and reaches React calls `resolveUpdatePriority()`, which reads
 * `window.event` and throws `ReferenceError: window is not defined`. If that
 * happens before the worker reports `stopped`, the run fails on whichever file
 * it was. On an idle machine the stop path finishes before a timer gets a turn.
 * Under turbo, with `next build` competing for the CPU, it sometimes does not:
 * the failure was seen on several different files, each with leftover timers,
 * and it would not reproduce in 28 local turbo runs — but such a callback does
 * throw exactly that error.
 *
 * So this file hands out tracked timers. It is listed first in `setupFiles`,
 * so it runs before anything imports React and the scheduler captures
 * `setImmediate`. It cancels every timer still pending after the file's last
 * hook, and it refuses to run a callback once the environment is gone. Timers
 * a test cares about have fired, or been awaited, long before `afterAll`; the
 * ones cancelled here are leftovers nobody was waiting for.
 * `vi.useFakeTimers()` still works: it swaps these globals out and puts them
 * back.
 */

type Handle = ReturnType<typeof globalThis.setTimeout> | ReturnType<typeof globalThis.setImmediate>;

const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
};

const timeouts = new Set<Handle>();
const intervals = new Set<Handle>();
const immediates = new Set<Handle>();

/** The environment is gone: `window` was deleted from the global. */
const tornDown = (): boolean => !('window' in globalThis);

function guard<A extends unknown[]>(callback: (...args: A) => void): (...args: A) => void {
  return (...args: A) => {
    if (tornDown()) return;
    callback(...args);
  };
}

globalThis.setTimeout = Object.assign(
  (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle: Handle = real.setTimeout(
      (...inner: unknown[]) => {
        timeouts.delete(handle);
        guard(callback)(...inner);
      },
      ms,
      ...args,
    );
    timeouts.add(handle);
    return handle;
  },
  real.setTimeout,
) as typeof globalThis.setTimeout;

globalThis.clearTimeout = ((handle?: Handle) => {
  if (handle !== undefined) timeouts.delete(handle);
  real.clearTimeout(handle as Parameters<typeof real.clearTimeout>[0]);
}) as typeof globalThis.clearTimeout;

globalThis.setInterval = Object.assign(
  (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle: Handle = real.setInterval(guard(callback), ms, ...args);
    intervals.add(handle);
    return handle;
  },
  real.setInterval,
) as typeof globalThis.setInterval;

globalThis.clearInterval = ((handle?: Handle) => {
  if (handle !== undefined) intervals.delete(handle);
  real.clearInterval(handle as Parameters<typeof real.clearInterval>[0]);
}) as typeof globalThis.clearInterval;

globalThis.setImmediate = Object.assign(
  (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
    const handle: Handle = real.setImmediate(
      (...inner: unknown[]) => {
        immediates.delete(handle);
        guard(callback)(...inner);
      },
      ...args,
    );
    immediates.add(handle);
    return handle;
  },
  real.setImmediate,
) as typeof globalThis.setImmediate;

globalThis.clearImmediate = ((handle?: Handle) => {
  if (handle !== undefined) immediates.delete(handle);
  real.clearImmediate(handle as Parameters<typeof real.clearImmediate>[0]);
}) as typeof globalThis.clearImmediate;

// Registered before any other hook, so under vitest's default `stack` order it
// runs after every other `afterAll` — the file's own and `setup.ts`'s.
afterAll(() => {
  for (const handle of timeouts)
    real.clearTimeout(handle as Parameters<typeof real.clearTimeout>[0]);
  for (const handle of intervals)
    real.clearInterval(handle as Parameters<typeof real.clearInterval>[0]);
  for (const handle of immediates)
    real.clearImmediate(handle as Parameters<typeof real.clearImmediate>[0]);
  timeouts.clear();
  intervals.clear();
  immediates.clear();
});
