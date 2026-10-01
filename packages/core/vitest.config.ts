import path from 'node:path';
import { shopVitest } from '@shop/config/vitest';

const here = import.meta.dirname;

export default shopVitest({
  dirname: here,
  // See the note in tsconfig.json: the harness is aliased rather than depended
  // on, to keep `@shop/core` and `@shop/testing` out of a workspace cycle.
  //
  // Vite matches a string alias as a *prefix*, so the subpath entries have to
  // come first: with `@shop/testing` alone, `@shop/testing/wechat` would be
  // rewritten to `…/src/index.ts/wechat`.
  alias: {
    '@shop/testing/wechat': path.resolve(here, '../testing/src/wechat/index.ts'),
    '@shop/testing': path.resolve(here, '../testing/src/index.ts'),
  },
  intGlobalSetup: path.resolve(here, '../testing/src/harness/global-setup.ts'),
});
