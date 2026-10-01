import type { MetadataRoute } from 'next';

/**
 * `/robots.txt` — nothing on this host is to be crawled. The shop lives in the
 * WeChat mini-program; the web has only the landing page and the admin, and the
 * root layout already marks every page `noindex`. This says the same thing to a
 * crawler before it fetches a page.
 *
 * The edge sends exactly `/robots.txt` here (`location = /robots.txt` in
 * docker/edge/nginx.conf), ahead of the rule that serves other root-level
 * `.txt` files from the WeChat domain-verification directory.
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/' } };
}
