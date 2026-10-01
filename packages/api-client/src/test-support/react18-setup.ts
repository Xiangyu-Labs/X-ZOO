/**
 * Setup for the `unit-react18` project only (see `vitest.config.ts`).
 *
 * `react-dom-18` is `npm:react-dom@18.3.1`, and pnpm satisfied its `react` peer
 * with this package's own React 19. Its CommonJS `require('react')` is beyond
 * any Vite alias, so this redirects exactly that require (from inside
 * react-dom 18, and nowhere else) to `react-18`, the same file the aliased
 * `import 'react'` of the tests and TanStack Query loads.
 */
import { realpathSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

const react18 = realpathSync(path.resolve(import.meta.dirname, '../../node_modules/react-18'));

type Resolve = (
  request: string,
  parent: { filename?: string | null } | undefined,
  ...rest: unknown[]
) => string;
const loader = Module as unknown as { _resolveFilename: Resolve };
const original = loader._resolveFilename;

loader._resolveFilename = function (request, parent, ...rest) {
  const fromReactDom18 = parent?.filename?.includes(`${path.sep}react-dom@18.`) ?? false;
  if (fromReactDom18 && (request === 'react' || request.startsWith('react/'))) {
    return original.call(this, path.join(react18, request.slice('react'.length)), parent, ...rest);
  }
  return original.call(this, request, parent, ...rest);
};
