/**
 * The CMS domain's public surface: 文章 and 文章分类.
 *
 * ## What other domains call
 *
 * | Export             | Caller   | When                                            |
 * | ------------------ | -------- | ----------------------------------------------- |
 * | `articles.*`       | routes   | the admin screens and the storefront reader      |
 * | `categories.*`     | routes   | the same, plus the storefront's tab bar          |
 * | `sanitizeHtml`     | anyone   | storing operator-authored HTML from another form |
 * | `cmsPermissions`   | registry | declared on import, read by the permission tree  |
 *
 * ## No ports
 *
 * Unlike `shipping`, importing this file registers nothing. The decoration
 * editor's article picker runs in the browser against the published routes,
 * so there is no server-side port to install.
 *
 * `sanitizeHtml` is exported because it is the only allow-list sanitiser in the
 * workspace: any other domain that ever stores rich text authored by an
 * operator should call this one rather than grow a second policy.
 */

export * as articles from './cms.article.service';
export * as categories from './cms.category.service';
export { isSafeUrl, sanitizeHtml } from './cms.sanitize';
export { cmsPermissions } from './permissions';
