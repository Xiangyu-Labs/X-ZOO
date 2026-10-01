/**
 * Taro plugin: lets the WeChat templates carry the ARIA attributes the kit sets.
 *
 * Taro's weapp templates only bind the attributes it knows per component, and `aria-*` are not
 * among them, so `<View ariaRole="button" ariaLabel="关闭">` would reach the page without them
 * (docs/mini/design.md §7: VoiceOver and TalkBack read `aria-role` + `aria-label`, base library
 * 2.7.1+). This is what `@tarojs/plugin-inject`'s `components` option does, without the extra
 * dependency — both halves of it: the templates, and the runtime's component table
 * (`a11y-runtime.js`). With the templates alone every `<image>` rendered blank and every button
 * behaved as disabled (a11y-components.js says why); `scripts/size-report.mjs` fails a build
 * that has one half without the other.
 *
 * H5 is untouched (the Taro web components take props directly).
 */
// Taro loads a plugin with require(), so this file is CommonJS.
/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');
const components = require('./a11y-components');

const RUNTIME = path.join(__dirname, 'a11y-runtime.js');

module.exports = (ctx) => {
  ctx.registerMethod({
    name: 'onSetupClose',
    fn(platform) {
      if (
        !platform ||
        !platform.template ||
        typeof platform.template.mergeComponents !== 'function'
      )
        return;
      platform.template.mergeComponents(ctx, components);
      const runtime = platform.runtimePath;
      platform.runtimePath = [...(Array.isArray(runtime) ? runtime : [runtime]), RUNTIME];
    },
  });
};
