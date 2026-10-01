/**
 * A minimal `renderHook` on `react-dom/client` and `React.act`, both of which
 * React 18.3 and 19 export. Testing Library's own reaches `react-dom` through
 * a CommonJS `require`, which the React 18 test project's alias cannot
 * redirect, so the hooks are rendered with this instead.
 */
import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { vi } from 'vitest';

const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
env.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `vi.waitFor`, with React told it is not under `act` while it polls: the
 * updates a settling query makes land between polls, outside any `act`, and
 * React would otherwise warn about each (Testing Library's `waitFor` does the
 * same).
 */
export async function waitFor(assertion: () => void): Promise<void> {
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion);
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

export interface RenderedHook<T> {
  result: { readonly current: T };
  unmount(): void;
}

export function renderHook<T>(
  hook: () => T,
  options: { wrapper: ComponentType<{ children: ReactNode }> },
): RenderedHook<T> {
  const result = { current: undefined as T };
  function Probe(): null {
    result.current = hook();
    return null;
  }
  // The package compiles without the DOM lib; happy-dom provides `document` at run time.
  const { document } = globalThis as unknown as {
    document: { createElement(tag: 'div'): Parameters<typeof createRoot>[0] };
  };
  const root = createRoot(document.createElement('div'));
  act(() => {
    root.render(createElement(options.wrapper, null, createElement(Probe)));
  });
  return { result, unmount: () => act(() => root.unmount()) };
}

export { act };
