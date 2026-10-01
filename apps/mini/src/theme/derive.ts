/**
 * `deriveTheme` / `themeStyle` (docs/mini/design.md §3.3): moved to
 * `@shop/contracts/system/theme` (zod-free), one implementation for the mini-program and the
 * admin preview. Tested there.
 */
export * from '@shop/contracts/system/theme';
export type { RadiusScale } from '@shop/contracts/system/app.schemas';
