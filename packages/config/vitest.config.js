import { shopVitest } from './vitest/index.js';

// This package is authored in plain JS (an ESLint config must be loadable
// without a transpile step), so its tests are `.js` too.
export default shopVitest({
  dirname: import.meta.dirname,
  unitInclude: ['src/**/*.test.js'],
  intInclude: ['src/**/*.int.test.js'],
});
