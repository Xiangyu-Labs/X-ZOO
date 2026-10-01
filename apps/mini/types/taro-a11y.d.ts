/**
 * The ARIA attributes `config/a11y-plugin.js` adds to the WeChat templates. Taro types only
 * `ariaRole` / `ariaLabel` on some components; these are the rest the kit uses.
 */
import '@tarojs/components/types/common';

declare module '@tarojs/components/types/common' {
  interface StandardProps {
    ariaRole?: string;
    ariaLabel?: string;
    ariaHidden?: boolean;
    ariaChecked?: boolean;
    ariaSelected?: boolean;
    ariaDisabled?: boolean;
    ariaModal?: boolean;
    ariaLive?: 'off' | 'polite' | 'assertive';
  }
}
