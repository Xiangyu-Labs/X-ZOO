/**
 * The allow-list sanitiser lives in the kernel (`kernel/sanitize-html.ts`) so
 * that `catalog` can use it for product descriptions without importing `cms`,
 * which imports `catalog`. Re-exported here for the article service and for
 * `cms`'s public surface.
 */
export { isSafeUrl, sanitizeHtml } from '../kernel/sanitize-html';
