/**
 * A query string (`a=1&b=x%20y`, no leading `?`) as an object: names and values URI-decoded,
 * `+` read as a space, the first of a repeated name kept.
 *
 * Not `Object.fromEntries(new URLSearchParams(…))`: on WeChat the build swaps `URLSearchParams`
 * for `@tarojs/runtime`'s, which is not iterable, so that throws on a phone while every test
 * (Node's own `URLSearchParams`) passes.
 */
export function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of search.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    const name = decode(at < 0 ? pair : pair.slice(0, at));
    if (!name || name in out) continue;
    out[name] = at < 0 ? '' : decode(pair.slice(at + 1));
  }
  return out;
}

function decode(value: string): string {
  const spaced = value.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}
