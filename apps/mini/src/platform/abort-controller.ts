/**
 * `AbortController` / `AbortSignal` for the WeChat runtime, which has neither: a phone throws
 * `ReferenceError` at the first `new AbortController()`. TanStack Query makes one for every
 * fetch, so without this no query ever sends its request and every page waits on its skeleton.
 * WeChat DevTools' simulator and the H5 e2e build have the browser's own, so only a phone shows
 * it.
 *
 * The weapp build provides these two names to every module that uses them as globals
 * (`ProvidePlugin` in config/index.ts); the H5 build keeps the browser's. Where a runtime has
 * its own, that one is used. `scripts/size-report.mjs` fails a weapp build in which a bare
 * `AbortController` is left.
 *
 * Only what the app and TanStack Query use: `signal.aborted`, `signal.reason`,
 * `addEventListener('abort', …, { once })`, `removeEventListener`, `onabort`,
 * `throwIfAborted()` and `abort(reason)`.
 */

type AbortListener = (event: { type: 'abort'; target: MiniAbortSignal }) => void;

const listenersOf = new WeakMap<MiniAbortSignal, Map<AbortListener, { once: boolean }>>();

export class MiniAbortSignal {
  aborted = false;
  reason: unknown = undefined;
  onabort: AbortListener | null = null;

  constructor() {
    listenersOf.set(this, new Map());
  }

  addEventListener(
    type: string,
    listener: AbortListener | null | undefined,
    options?: boolean | { once?: boolean },
  ): void {
    if (type !== 'abort' || !listener) return;
    const once = typeof options === 'object' && options !== null && options.once === true;
    listenersOf.get(this)?.set(listener, { once });
  }

  removeEventListener(type: string, listener: AbortListener | null | undefined): void {
    if (type !== 'abort' || !listener) return;
    listenersOf.get(this)?.delete(listener);
  }

  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }
}

function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

export class MiniAbortController {
  readonly signal = new MiniAbortSignal();

  abort(reason?: unknown): void {
    const signal = this.signal;
    if (signal.aborted) return;
    signal.aborted = true;
    signal.reason = reason === undefined ? abortError() : reason;
    const event = { type: 'abort' as const, target: signal };
    signal.onabort?.(event);
    const listeners = listenersOf.get(signal);
    if (!listeners) return;
    for (const [listener, { once }] of [...listeners]) {
      if (once) listeners.delete(listener);
      listener(event);
    }
  }
}

// `typeof` first: iOS 12.0/12.1's JavaScriptCore has no `globalThis`, and a bare read would throw.
// eslint-disable-next-line no-restricted-globals -- read only behind the typeof check
const native = (typeof globalThis === 'object' ? globalThis : {}) as {
  AbortController?: typeof MiniAbortController;
  AbortSignal?: typeof MiniAbortSignal;
};

export const AbortController: typeof MiniAbortController =
  typeof native.AbortController === 'function' ? native.AbortController : MiniAbortController;

export const AbortSignal: typeof MiniAbortSignal =
  typeof native.AbortSignal === 'function' ? native.AbortSignal : MiniAbortSignal;
