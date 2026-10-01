import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';

/**
 * Setup file of the `unit-react18` project only.
 *
 * `react-dom-18` is `npm:react-dom@18.3.1`, but pnpm satisfies its `react` peer
 * with this package's own `react` (19), so its `require('react')` would load
 * React 19 into React DOM 18 ("Cannot read properties of undefined (reading
 * 'ReactCurrentDispatcher')"). Vite's alias cannot reach a `require` inside an
 * externalised dependency; a Node resolve hook can. It sends `react` (and
 * `react/*`) to `react-18` whenever the importer is React DOM 18.
 */

// Vitest runs from the package root.
const react18 = resolve(process.cwd(), 'node_modules/react-18');

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromReactDom18 = context.parentURL?.includes('/react-dom@18.') ?? false;
    if (fromReactDom18 && (specifier === 'react' || specifier.startsWith('react/'))) {
      const rest = specifier === 'react' ? 'index.js' : `${specifier.slice('react/'.length)}.js`;
      return nextResolve(join(react18, rest), context);
    }
    return nextResolve(specifier, context);
  },
});
