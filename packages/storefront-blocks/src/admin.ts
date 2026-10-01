/**
 * The admin canvas entry. `scripts/build.ts` bundles this file with
 * `@tarojs/components` aliased to the DOM shim and every `*.module.scss`
 * compiled with px → vw, into `dist/admin.js` + `dist/admin.css` (and the CSS
 * as a string in `dist/admin-css.js`, for injecting into the canvas iframe).
 * Types come from here; at runtime the admin imports the built files.
 */
export * from './blocks';
