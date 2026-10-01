/**
 * HTML sanitiser for operator-authored rich text: article bodies (`cms`) and
 * product descriptions (`catalog`). In the kernel because both domains need it
 * and `cms` already imports `catalog`.
 *
 * Escaping on save and unescaping on every read is a round trip that nets
 * exactly zero: whatever the editor produced, `<script>` included, would be
 * stored and served verbatim to every visitor. This file runs **on write**
 * instead: what the database holds is already safe, so a read path that forgets
 * to escape cannot reintroduce the hole.
 *
 * Hand-written rather than a library on purpose: the input is one WYSIWYG
 * editor's output (Tiptap), the allow-list is 25 tags long, and a dependency
 * that parses arbitrary HTML is a bigger attack surface than the 80 lines
 * below. The rules:
 *
 *  - only allow-listed tags survive; everything else is dropped, and the
 *    *content* of `script`, `style`, `iframe` and friends goes with the tag;
 *  - only allow-listed attributes survive, never `on*`;
 *  - `href` and `src` must be `http`, `https`, a site-relative path or a
 *    `data:image/...` — which kills `javascript:` and `vbscript:`, including
 *    the `java\nscript:` spelling that a naive `startsWith` check misses;
 *  - comments go, because `<!--[if IE]><script>` is a real technique;
 *  - it is **idempotent**: the editor loads what was stored and sends it back,
 *    so a second pass must not change it. Text keeps its entity references
 *    (`&amp;` stays `&amp;`, not `&amp;amp;`), attribute values are decoded
 *    before they are judged and escaped once, and a link's `rel` is replaced,
 *    never appended to.
 */

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'hr',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'img',
  'video',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'span',
  'div',
  'code',
  'pre',
  'figure',
  'figcaption',
]);

/** Tags whose *content* is dropped along with the tag. */
const VOID_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template']);

const SELF_CLOSING = new Set(['br', 'hr', 'img']);

const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  video: new Set(['src', 'poster', 'controls', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
  '*': new Set(['class', 'style']),
};

const URL_ATTRIBUTES = new Set(['href', 'src', 'poster']);

/** `style` is allowed, but only as declarations with no `url(` / `expression(`. */
const DANGEROUS_STYLE = /(url\s*\(|expression\s*\(|javascript\s*:|@import)/i;

export function sanitizeHtml(input: string): string {
  if (input === '') return '';
  let out = '';
  let index = 0;
  const open: string[] = [];

  while (index < input.length) {
    const next = input.indexOf('<', index);
    if (next === -1) {
      out += escapeText(input.slice(index));
      break;
    }
    out += escapeText(input.slice(index, next));

    // A comment, a CDATA block or a doctype: skip to its end and emit nothing.
    if (input.startsWith('<!', next)) {
      const end = input.indexOf('>', next);
      index = end === -1 ? input.length : end + 1;
      continue;
    }

    // `5 < 6` is text: a tag has to start with a letter or a slash. Browsers
    // agree, and an operator typing an inequality is more likely than markup.
    if (!/^[a-zA-Z/]/.test(input.slice(next + 1, next + 2))) {
      out += escapeText('<');
      index = next + 1;
      continue;
    }

    const end = findTagEnd(input, next + 1);
    if (end === -1) {
      // A stray `<` with no matching `>`: it is text, not markup.
      out += escapeText(input.slice(next));
      break;
    }
    const raw = input.slice(next + 1, end).trim();
    index = end + 1;

    const closing = raw.startsWith('/');
    const body = closing ? raw.slice(1).trim() : raw;
    const name = (body.split(/[\s/>]/, 1)[0] ?? '').toLowerCase();
    if (name === '') continue;

    if (VOID_CONTENT_TAGS.has(name)) {
      if (!closing) index = skipContent(input, index, name);
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;

    if (closing) {
      const position = open.lastIndexOf(name);
      if (position === -1) continue;
      // Close everything that was opened inside it, so the output nests.
      for (let depth = open.length - 1; depth >= position; depth -= 1) {
        out += `</${open[depth] ?? ''}>`;
      }
      open.length = position;
      continue;
    }

    const attributes = sanitizeAttributes(name, body.slice(name.length));
    if (SELF_CLOSING.has(name)) {
      out += `<${name}${attributes} />`;
      continue;
    }
    out += `<${name}${attributes}>`;
    open.push(name);
  }

  for (let depth = open.length - 1; depth >= 0; depth -= 1) out += `</${open[depth] ?? ''}>`;
  return out;
}

/**
 * The `>` that ends this tag, skipping any that sit inside a quoted attribute
 * value — `<a href="data:text/html,<b>">` is one tag, not two.
 */
function findTagEnd(input: string, from: number): number {
  let quote: string | null = null;
  for (let at = from; at < input.length; at += 1) {
    const char = input[at];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return at;
  }
  return -1;
}

/** Everything up to the matching close tag of a content-dropping element. */
function skipContent(input: string, from: number, name: string): number {
  const close = input.toLowerCase().indexOf(`</${name}`, from);
  if (close === -1) return input.length;
  const end = input.indexOf('>', close);
  return end === -1 ? input.length : end + 1;
}

const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function sanitizeAttributes(tag: string, source: string): string {
  const allowed = ALLOWED_ATTRIBUTES[tag];
  const common = ALLOWED_ATTRIBUTES['*'];
  let out = '';
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    // `on*` never survives, whatever the tag.
    if (name.startsWith('on')) continue;
    if (!(allowed?.has(name) ?? false) && !(common?.has(name) ?? false)) continue;
    // Ours is added below; keeping theirs as well would add one per save.
    if (tag === 'a' && name === 'rel') continue;
    // Judged and written as the value the browser will see: `&amp;` in a
    // stored URL is `&`, and is escaped back exactly once.
    const decoded = decodeAttribute(value);
    if (URL_ATTRIBUTES.has(name) && !isSafeUrl(decoded)) continue;
    if (name === 'style' && DANGEROUS_STYLE.test(decoded)) continue;
    out += ` ${name}="${escapeAttribute(decoded)}"`;
  }
  // An external link opened in a new tab without `noopener` hands the opener
  // window to whoever wrote the article.
  if (tag === 'a' && out.includes('target=')) out += ' rel="noopener noreferrer"';
  return out;
}

export function isSafeUrl(value: string): boolean {
  // Entities and control characters are how `javascript:` gets smuggled past a
  // prefix check (`java&#x09;script:`), so they are stripped before the test.
  // Written as a filter rather than a `[\x00-\x20]` regex: the class needs
  // literal control characters, which `no-control-regex` rejects on sight.
  const cleaned = [...decodeEntities(value)]
    .filter((char) => char.charCodeAt(0) > 0x20)
    .join('')
    .toLowerCase();
  if (cleaned === '') return false;
  if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) return true;
  if (cleaned.startsWith('/') && !cleaned.startsWith('//')) return true;
  if (cleaned.startsWith('data:image/')) return true;
  // A bare relative path (`uploads/a.png`) is fine as long as it names no scheme.
  return !/^[a-z][a-z0-9+.-]*:/.test(cleaned);
}

function decodeEntities(value: string): string {
  return value.replace(/&#(x?)([0-9a-fA-F]+);?/g, (_match, hex: string, code: string) => {
    const point = Number.parseInt(code, hex === '' ? 10 : 16);
    // `&#99999999;` is no code point: `fromCodePoint` would throw and turn a
    // typo into a 500.
    return Number.isNaN(point) || point > 0x10ffff ? '' : String.fromCodePoint(point);
  });
}

/**
 * The named references an attribute value is decoded through. Anything else
 * (`&colon;`, say) stays literal text — its `&` is escaped — which is the safe
 * direction: it can never turn into a `:` that `isSafeUrl` did not see.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

function decodeAttribute(value: string): string {
  return decodeEntities(value).replace(
    /&([a-zA-Z]+);/g,
    (match, name: string) => NAMED_ENTITIES[name] ?? match,
  );
}

/**
 * `<` and `>` in text always escape; `&` only when it does not already start
 * an entity reference. In text a reference only ever decodes to a character,
 * never to markup, so keeping it is safe — and it is what keeps a second pass
 * from turning `&amp;` into `&amp;amp;`.
 */
function escapeText(value: string): string {
  return value
    .replace(/&(?!(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
