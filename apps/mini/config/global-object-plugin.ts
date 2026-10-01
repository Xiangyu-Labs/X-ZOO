import type { Compiler } from 'webpack';

/**
 * Replaces webpack's `__webpack_require__.g` runtime module, whose fallback is
 * `this || new Function('return this')()`.
 *
 * A mini-program forbids `new Function` and `eval` (they throw at runtime), and our size check
 * fails a build that contains either, so the fallback is dead code that trips the scan. Taro's
 * own runtime (`@tarojs/runtime/dist/bom/window.js`) reads `global`, which is what pulls this
 * module in. The replacement keeps the two branches that can succeed: `globalThis` (every
 * base library ≥ 3.0) and `window` (H5).
 */
export class GlobalObjectPlugin {
  apply(compiler: Compiler): void {
    const globalVar = compiler.webpack.RuntimeGlobals.global;
    compiler.hooks.compilation.tap('GlobalObjectPlugin', (compilation) => {
      compilation.hooks.runtimeModule.tap('GlobalObjectPlugin', (module) => {
        if (module.name !== 'global') return;
        module.generate = () =>
          [
            `${globalVar} = (function() {`,
            "  if (typeof globalThis === 'object') return globalThis;",
            "  if (typeof window === 'object') return window;",
            '})();',
          ].join('\n');
      });
    });
  }
}
