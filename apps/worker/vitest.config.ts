import path from 'node:path';
import { shopVitest } from '@shop/config/vitest';

export default shopVitest({
  dirname: import.meta.dirname,
  intGlobalSetup: path.resolve(
    import.meta.dirname,
    '../../packages/testing/src/harness/global-setup.ts',
  ),
});
