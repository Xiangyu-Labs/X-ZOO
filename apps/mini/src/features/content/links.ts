export interface ContentLink {
  href: string;
  text: string;
}

const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

function decode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * The http(s) links in operator HTML, in order and once each. `<rich-text>` draws them as
 * plain text (C12), so an article lists them under its body, where a tap goes through
 * `openExternalLink` (web-view for a 业务域名, else copied).
 */
export function extractLinks(html: string): ContentLink[] {
  const seen = new Set<string>();
  const links: ContentLink[] = [];
  // `exec`, not `matchAll`: iOS 12's JavaScriptCore has no `matchAll` and nothing polyfills it.
  ANCHOR.lastIndex = 0;
  for (let match = ANCHOR.exec(html); match; match = ANCHOR.exec(html)) {
    const href = decode(match[2] ?? '').trim();
    if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
    seen.add(href);
    const text = decode((match[3] ?? '').replace(/<[^>]*>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    links.push({ href, text: text || href });
  }
  return links;
}
