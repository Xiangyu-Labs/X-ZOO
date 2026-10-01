import { z } from 'zod';

import { id } from '../_conventions/common';
import {
  storefrontRoute,
  storefrontRouteDef,
  type StorefrontRoute,
} from '../system/storefront-routes';
import { ui } from './meta';

/**
 * `LinkTarget` — what a tap on a decorated block opens (plan §2.1).
 *
 * A saved page never stores a mini-program path. It stores *what* the link
 * opens; the route catalogue (`system/storefront-routes.ts`) turns that into a
 * path at the edge (`linkTargetRoute` in `link-route.ts`). Renaming a page then
 * never breaks saved data, and the same catalogue serves mini-program codes,
 * subscribe messages, posters and in-app message links.
 *
 * | kind          | stores                         | opens                                     |
 * | ------------- | ------------------------------ | ----------------------------------------- |
 * | `product`     | product id                     | `product { id }`                          |
 * | `category`    | category id                    | `productList { categoryId }`              |
 * | `article`     | article id                     | `article { id }`                          |
 * | `page`        | decor document id (微页面)     | `page { id }`                             |
 * | `route`       | `{ route, params }`            | that catalogue entry; `linkable` keys only |
 * | `webview`     | an https URL                   | `webview { url }` (the client checks C12) |
 * | `miniprogram` | AppID + optional path          | `navigateToMiniProgram`, not the catalogue |
 */

/**
 * A catalogue route an operator may link to: the key must be `linkable`
 * (docs/mini/pages.md §3.2) and its params must parse for that key.
 */
export const linkableRoute = storefrontRoute.refine(
  (route: StorefrontRoute) => storefrontRouteDef(route.route).linkable === true,
  { message: '该页面不能作为装修链接' },
);

export const linkTarget = z
  .discriminatedUnion(
    'kind',
    [
      z.object({ kind: z.literal('product'), id }),
      z.object({ kind: z.literal('category'), id }),
      z.object({ kind: z.literal('article'), id }),
      /** A decorated micro page (a `decor_documents` row of kind `custom`). */
      z.object({ kind: z.literal('page'), id }),
      z.object({ kind: z.literal('route'), to: linkableRoute }),
      /**
       * A web page in `<web-view>`. The mini-program can open only verified
       * business domains; the client checks the host (C12) and copies any other
       * link instead of opening it.
       */
      z.object({ kind: z.literal('webview'), url: z.url({ protocol: /^https$/ }).max(2048) }),
      z.object({
        kind: z.literal('miniprogram'),
        appId: z.string().regex(/^wx[0-9a-f]{16}$/, '小程序 AppID 形如 wx 加 16 位十六进制'),
        path: z.string().max(256).optional(),
      }),
    ],
    {
      // A required link left unpicked (a new 热区) reads as what to do, not as a type error.
      error: (issue) => (issue.input === undefined ? '请选择跳转链接' : undefined),
    },
  )
  .meta(ui({ label: '链接', field: 'link' }));

export type LinkTarget = z.infer<typeof linkTarget>;
