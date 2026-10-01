import { emulationPlatform } from './h5-mp-emulation';
import { previewPlatform } from './h5-preview';
import type { MiniPlatform } from './types';

/**
 * H5 builds only (Taro resolves this file over `runtime.tsx` when `TARO_ENV` is `h5`), so
 * nothing here, and nothing it imports, reaches the WeChat package.
 *
 * `TARO_APP_PLATFORM_EMULATION` is fixed at build time (`config/index.ts`); the choice is a
 * constant, not a runtime switch a URL could flip.
 */
export const platform: MiniPlatform =
  process.env.TARO_APP_PLATFORM_EMULATION === 'mp' ? emulationPlatform : previewPlatform;
