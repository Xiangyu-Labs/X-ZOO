import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A minimal `render` over `react-dom/client`, instead of Testing Library's.
 *
 * `@testing-library/react` is CommonJS and `require`s `react-dom` itself, which
 * no Vite alias can reach, so under the `unit-react18` project it would mount
 * React 18 elements with React DOM 19. This helper imports `react-dom` through
 * the alias like everything else; queries and events come from the
 * framework-agnostic `@testing-library/dom`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted = new Set<{ root: Root; container: HTMLElement }>();

export interface Rendered {
  container: HTMLElement;
  rerender: (next: ReactElement) => void;
  unmount: () => void;
}

export function render(ui: ReactElement): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const entry = { root, container };
  mounted.add(entry);
  act(() => root.render(ui));
  return {
    container,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      mounted.delete(entry);
    },
  };
}

export function cleanup(): void {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.clear();
}

export { act };
