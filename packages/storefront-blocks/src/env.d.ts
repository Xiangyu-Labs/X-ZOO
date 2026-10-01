/**
 * Plain `.css` imports are side effects only. The `*.module.scss` imports are
 * typed per file by the committed `*.module.scss.d.ts` next to each stylesheet
 * (`pnpm --filter @shop/storefront-blocks gen` rewrites them), so a block that
 * names a class its stylesheet lacks does not compile.
 */
declare module '*.css';
