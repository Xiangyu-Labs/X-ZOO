/**
 * Imported first by the weapp app entry (`a11y-plugin.js` adds it to the platform's runtime
 * paths): gives the runtime's component table the ARIA attributes the templates were built with,
 * before the first render numbers them. `@tarojs/shared` is imported, not required, so webpack
 * resolves the same module instance the Taro runtime uses.
 */
import { mergeInternalComponents } from '@tarojs/shared';
import components from './a11y-components';

mergeInternalComponents(components);
