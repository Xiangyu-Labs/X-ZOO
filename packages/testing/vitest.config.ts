import path from 'node:path';
import { shopVitest } from '@shop/config/vitest';

const here = import.meta.dirname;

export default shopVitest({
  dirname: here,
  intGlobalSetup: path.resolve(here, 'src/harness/global-setup.ts'),
});
