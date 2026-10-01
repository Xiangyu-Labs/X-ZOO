/**
 * The 富文本 block's HTML allow-list (DECOR-017).
 *
 * An operator's rich text is stored as HTML, but only HTML this file lets
 * through: `sanitizeRichText` runs on save (the block schema overwrites the
 * value with it, so `checkDocument` stores the clean string), again in the page
 * resolver (it parses the same schema), and a third time on the client, where
 * `parseRichText` turns the string into the node array that Taro's `RichText`
 * (WeChat `<rich-text nodes>`) draws. A value can reach a phone only through
 * one of these, so a draft edited through the API or a revision written before
 * a rule tightened is still clean when it is shown.
 *
 * The rules, all allow-lists:
 *
 * - **Tags.** Text structure only (`ALLOWED_TAGS`). `script`, `style`,
 *   `iframe`, embedded objects, forms, media and SVG are dropped *with their
 *   content* (`DROPPED_TAGS`). Anything else (`a`, `font`, `section`, custom
 *   elements) is unwrapped: its text stays, the tag goes. Links are unwrapped
 *   on purpose — a link inside WeChat's rich text cannot navigate.
 * - **Attributes.** None, except `style` (filtered below) and, on `img`, `src`
 *   and `alt`. No `class`, no `id`, no event handlers, no `data-*`.
 * - **Inline style.** Only colour, background colour, alignment, weight,
 *   italics and underline/strike, each with a value of a strict shape. No
 *   `url()`, no positioning, no sizes — nothing that can cover the page or
 *   load something.
 * - **Images.** `src` must be `https://` or a site-relative `/path`; the style
 *   is replaced by `max-width:100%;height:auto;display:block`, so a picture
 *   never overflows the screen whatever size it was pasted at.
 * - **Size.** At most `RICH_TEXT_LIMITS.nodes` nodes, nested at most
 *   `RICH_TEXT_LIMITS.depth` deep; the rest is cut.
 *
 * **Zod-free and dependency-free on purpose** (like `constants.ts`): the
 * mini-program imports it at runtime to build the nodes. It is a small
 * tokenizer, not a browser parser: malformed markup degrades to text, never to
 * markup.
 */

/** A text node: `text` is decoded (no entities). */
export interface RichTextText {
  type: 'text';
  text: string;
}

/** An element node, in the shape WeChat's `<rich-text nodes>` takes. */
export interface RichTextElement {
  name: string;
  attrs?: Record<string, string>;
  children?: RichTextNode[];
}

export type RichTextNode = RichTextText | RichTextElement;

export const RICH_TEXT_LIMITS = {
  /** Characters of stored HTML. */
  htmlLength: 20_000,
  /** Nodes kept after parsing; the rest is cut. */
  nodes: 2_000,
  /** Nesting kept; deeper content is flattened into its ancestor at this depth. */
  depth: 12,
} as const;

/** Tags kept as they are (with filtered attributes). */
const ALLOWED_TAGS = new Set([
  'p',
  'div',
  'span',
  'br',
  'hr',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'sub',
  'sup',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'img',
]);

/** Tags dropped together with everything inside them. */
const DROPPED_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'noscript',
  'template',
  'textarea',
  'select',
  'option',
  'button',
  'input',
  'form',
  'svg',
  'math',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'map',
  'link',
  'meta',
  'base',
  'title',
  'head',
]);

/** Elements that never have children. */
const VOID_TAGS = new Set([
  'br',
  'hr',
  'img',
  'input',
  'meta',
  'link',
  'source',
  'track',
  'base',
  'embed',
  'param',
  'area',
  'col',
  'wbr',
  'keygen',
]);

/** Style properties kept, each with the shape its value must have. */
const STYLE_RULES: Readonly<Record<string, RegExp>> = {
  color: /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.\s,%]+\)|[a-z]{3,20})$/i,
  'background-color': /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.\s,%]+\)|[a-z]{3,20})$/i,
  'text-align': /^(left|right|center|justify)$/,
  'font-weight': /^(normal|bold|[1-9]00)$/,
  'font-style': /^(normal|italic)$/,
  'text-decoration': /^(none|underline|line-through)$/,
};

/** Replaces whatever style an image had. */
export const RICH_TEXT_IMAGE_STYLE = 'max-width:100%;height:auto;display:block';

const IMAGE_SRC = /^(https:\/\/|\/(?!\/))[^\s"'<>\\]{1,2040}$/i;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  times: '×',
  yen: '¥',
  copy: '©',
  reg: '®',
};

/** Decodes the entities a pasted document realistically holds; an unknown one stays as typed. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // No NUL, no surrogates, nothing past Unicode.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      if (code >= 0xd800 && code <= 0xdfff) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/** Keeps the allowed declarations of an inline style, normalised; `''` when none survive. */
export function sanitizeStyle(style: string): string {
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .trim()
      .replace(/\s*!important$/i, '');
    const rule = STYLE_RULES[property];
    if (!rule || value.length > 40 || !rule.test(value)) continue;
    kept.push(`${property}:${value}`);
  }
  return kept.join(';');
}

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: 'close'; name: string };

const TAG_NAME = /^[a-z][a-z0-9-]{0,30}/i;
const ATTRIBUTE = /^([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/;

/** Splits markup into text, opening and closing tags; comments and doctypes vanish. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let text = '';
  const flush = () => {
    if (text) tokens.push({ kind: 'text', text: decodeEntities(text) });
    text = '';
  };
  while (at < html.length) {
    const lt = html.indexOf('<', at);
    if (lt < 0) {
      text += html.slice(at);
      break;
    }
    text += html.slice(at, lt);
    at = lt;
    if (html.startsWith('<!--', at)) {
      const end = html.indexOf('-->', at + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[at + 1] === '!' || html[at + 1] === '?') {
      const end = html.indexOf('>', at);
      at = end < 0 ? html.length : end + 1;
      continue;
    }
    const closing = html[at + 1] === '/';
    const nameMatch = TAG_NAME.exec(html.slice(at + (closing ? 2 : 1)));
    if (!nameMatch) {
      // A lone `<` is text.
      text += '<';
      at += 1;
      continue;
    }
    flush();
    const name = nameMatch[0].toLowerCase();
    let cursor = at + (closing ? 2 : 1) + nameMatch[0].length;
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      while (cursor < html.length && /\s/.test(html[cursor] ?? '')) cursor += 1;
      const char = html[cursor];
      if (char === undefined) break;
      if (char === '>') {
        cursor += 1;
        break;
      }
      if (char === '/') {
        selfClosing = html[cursor + 1] === '>';
        cursor += 1;
        continue;
      }
      const attribute = ATTRIBUTE.exec(html.slice(cursor));
      if (!attribute) {
        cursor += 1;
        continue;
      }
      const key = (attribute[1] ?? '').toLowerCase();
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      if (!(key in attrs)) attrs[key] = decodeEntities(value);
      cursor += attribute[0].length;
    }
    at = cursor;
    tokens.push(closing ? { kind: 'close', name } : { kind: 'open', name, attrs, selfClosing });
    if (!closing && (name === 'script' || name === 'style' || name === 'textarea')) {
      // Raw-text elements: their content is never markup; skip to the end tag.
      const end = html.toLowerCase().indexOf(`</${name}`, at);
      at = end < 0 ? html.length : end;
    }
  }
  flush();
  return tokens;
}

// ---------------------------------------------------------------------------
// tree building + allow-list
// ---------------------------------------------------------------------------

function cleanAttributes(name: string, attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (name === 'img') {
    const src = (attrs.src ?? '').trim();
    if (IMAGE_SRC.test(src) && !/^javascript:/i.test(src)) out.src = src;
    const alt = (attrs.alt ?? '').trim().slice(0, 100);
    if (alt) out.alt = alt;
    out.style = RICH_TEXT_IMAGE_STYLE;
    return out;
  }
  const style = sanitizeStyle(attrs.style ?? '');
  if (style) out.style = style;
  return out;
}

interface Frame {
  name: string;
  children: RichTextNode[];
  /** Kept in the output (false: unwrapped, its children go to the parent). */
  kept: boolean;
}

/**
 * Parses `html` into allow-listed nodes, ready for `<rich-text nodes>`.
 * Whitespace-only text between block elements is kept as it came (WeChat
 * collapses it like a browser).
 */
export function parseRichText(html: string): RichTextNode[] {
  const source = html.slice(0, RICH_TEXT_LIMITS.htmlLength * 2);
  const root: Frame = { name: '#root', children: [], kept: true };
  const stack: Frame[] = [root];
  /** Depth of `DROPPED_TAGS` we are inside (their content is skipped). */
  let dropping = 0;
  let count = 0;
  const top = () => stack[stack.length - 1] as Frame;
  const keptDepth = () => stack.filter((frame) => frame.kept).length - 1;
  const append = (node: RichTextNode) => {
    if (count >= RICH_TEXT_LIMITS.nodes) return;
    count += 1;
    top().children.push(node);
  };

  for (const token of tokenize(source)) {
    if (token.kind === 'text') {
      if (dropping === 0 && token.text) append({ type: 'text', text: token.text });
      continue;
    }
    const name = token.name;
    if (token.kind === 'open') {
      if (DROPPED_TAGS.has(name)) {
        if (!VOID_TAGS.has(name) && !token.selfClosing) dropping += 1;
        continue;
      }
      if (dropping > 0) continue;
      const allowed = ALLOWED_TAGS.has(name);
      if (VOID_TAGS.has(name) || token.selfClosing) {
        if (!allowed) continue;
        const attrs = cleanAttributes(name, token.attrs);
        if (name === 'img' && !attrs.src) continue;
        append({ name, attrs });
        continue;
      }
      const kept = allowed && keptDepth() < RICH_TEXT_LIMITS.depth;
      const frame: Frame = { name, children: [], kept };
      if (kept) {
        const attrs = cleanAttributes(name, token.attrs);
        const element: RichTextElement = { name, children: frame.children };
        if (Object.keys(attrs).length > 0) element.attrs = attrs;
        append(element);
      }
      stack.push(frame);
      continue;
    }
    // closing tag
    if (DROPPED_TAGS.has(name)) {
      if (dropping > 0) dropping -= 1;
      continue;
    }
    if (dropping > 0) continue;
    const index = stack.map((frame) => frame.name).lastIndexOf(name);
    if (index <= 0) continue; // a stray end tag
    // Close everything opened after it (implicitly closed, like a browser would).
    while (stack.length > index) {
      const frame = stack.pop() as Frame;
      if (!frame.kept) top().children.push(...frame.children);
    }
  }
  while (stack.length > 1) {
    const frame = stack.pop() as Frame;
    if (!frame.kept) top().children.push(...frame.children);
  }
  return root.children;
}

function serializeNodes(nodes: readonly RichTextNode[]): string {
  let out = '';
  for (const node of nodes) {
    if ('type' in node) {
      out += escapeText(node.text);
      continue;
    }
    const attrs = Object.entries(node.attrs ?? {})
      .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
      .join('');
    if (VOID_TAGS.has(node.name)) {
      out += `<${node.name}${attrs}>`;
      continue;
    }
    out += `<${node.name}${attrs}>${serializeNodes(node.children ?? [])}</${node.name}>`;
  }
  return out;
}

/** Nodes back to HTML: the canonical, stored form. */
export function serializeRichText(nodes: readonly RichTextNode[]): string {
  return serializeNodes(nodes);
}

/**
 * The stored form of `html`: parsed through the allow-list and written back.
 * Idempotent — sanitising clean HTML returns it unchanged.
 */
export function sanitizeRichText(html: string): string {
  return serializeRichText(parseRichText(html));
}

/** The visible text of `html`, e.g. for a length check or a summary. */
export function richTextPlainText(nodes: readonly RichTextNode[]): string {
  return nodes
    .map((node) => ('type' in node ? node.text : richTextPlainText(node.children ?? [])))
    .join('');
}
