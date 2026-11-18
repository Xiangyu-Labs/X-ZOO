import { RichText as NativeRichText } from '@tarojs/components';
import { useMemo } from 'react';

import type { RichTextProps as RichTextBlockProps } from '@shop/contracts/decor/all-blocks';
import { parseRichText, type RichTextNode } from '@shop/contracts/decor/rich-text';
import { BlockFrame } from '../shared/frame';
import type { BlockProps, ImageResolver } from '../shared/types';
import styles from './rich-text.module.scss';

/**
 * Each tag's look, as an inline style. `<rich-text>` content cannot be reached
 * by the page's classes on every platform, so the typography travels on the
 * nodes themselves — in `em`, relative to the block's own font size, so
 * nothing needs a px transform. The operator's own (allow-listed) style comes
 * after and wins.
 */
const BASE_STYLE: Readonly<Record<string, string>> = {
  p: 'margin:0 0 0.6em;',
  div: 'margin:0;',
  h1: 'margin:0 0 0.5em;font-size:1.43em;font-weight:600;line-height:1.35;',
  h2: 'margin:0 0 0.5em;font-size:1.29em;font-weight:600;line-height:1.35;',
  h3: 'margin:0 0 0.5em;font-size:1.14em;font-weight:600;line-height:1.4;',
  h4: 'margin:0 0 0.5em;font-size:1em;font-weight:600;',
  h5: 'margin:0 0 0.5em;font-size:1em;font-weight:600;',
  h6: 'margin:0 0 0.5em;font-size:1em;font-weight:600;',
  ul: 'margin:0 0 0.6em;padding-left:1.4em;',
  ol: 'margin:0 0 0.6em;padding-left:1.4em;',
  li: 'margin:0 0 0.2em;',
  blockquote:
    'margin:0 0 0.6em;padding:0.2em 0 0.2em 0.8em;border-left:0.2em solid #e5e5e5;color:#666666;',
  pre: 'margin:0 0 0.6em;padding:0.6em;background:#f7f7f7;white-space:pre-wrap;word-break:break-all;font-size:0.86em;',
  code: 'font-family:Menlo,Consolas,monospace;font-size:0.93em;',
  hr: 'margin:0.8em 0;border:0;border-top:1px solid #e5e5e5;',
  img: 'margin:0;',
};

/** The block's gutter (24 on a 28 font), for text beside edge-to-edge pictures. */
const TEXT_INSET = 'margin:0 0.86em;';

/** Below a picture that text follows; pictures in a row touch, as a sliced long poster must. */
const PICTURE_GAP = 'margin-bottom:0.6em;';

/**
 * A picture, or a paragraph holding nothing but pictures and blank space (`<p><img></p>`, the
 * old editor's way of inserting one).
 */
function picture(node: RichTextNode): boolean {
  if ('type' in node) return false;
  if (node.name === 'img') return true;
  if (node.name !== 'p' && node.name !== 'div') return false;
  const children = node.children ?? [];
  return (
    children.some((child) => !('type' in child) && child.name === 'img') &&
    children.every((child) => blank(child) || (!('type' in child) && child.name === 'img'))
  );
}

/**
 * Styles each node, and loads each picture through the host's resolver: the admin editor
 * stores a site-relative `/uploads/…` path, which loads nothing in the mini-program until it
 * is put against the shop's origin. The original, never a smaller copy: `<rich-text>` has no
 * fallback when a copy is missing.
 *
 * Pictures in a row have no gap between them; one that text follows keeps a gap below. A
 * picture paragraph keeps only its pictures: a `<br>` or `&nbsp;` beside a block picture is a
 * blank line of its own.
 */
function styled(nodes: readonly RichTextNode[], resolve?: ImageResolver): RichTextNode[] {
  return nodes.map((node, index) => {
    if ('type' in node) return node;
    const isPicture = picture(node);
    const next = nodes.slice(index + 1).find((sibling) => !('type' in sibling) || !blank(sibling));
    let base = BASE_STYLE[node.name] ?? '';
    if (isPicture) base = 'margin:0;' + (next && !picture(next) ? PICTURE_GAP : '');
    const own = node.attrs?.style ?? '';
    const attrs = { ...node.attrs };
    if (base || own) attrs.style = base + own;
    if (node.name === 'img' && attrs.src && resolve) attrs.src = resolve(attrs.src);
    const children = isPicture
      ? node.children?.filter((child) => !('type' in child) && child.name === 'img')
      : node.children;
    return {
      name: node.name,
      attrs,
      ...(children ? { children: styled(children, resolve) } : {}),
    };
  });
}

/** A paragraph with nothing to read in it: blank text, `<br>`, or empty paragraphs. */
function blank(node: RichTextNode): boolean {
  if ('type' in node) return node.text.replace(/&nbsp;|\s/g, '') === '';
  if (node.name === 'br') return true;
  if (node.name !== 'p' && node.name !== 'div') return false;
  return (node.children ?? []).every(blank);
}

/** Without the empty paragraphs an editor leaves at the start and the end (blank space). */
function trimBlank(nodes: readonly RichTextNode[]): RichTextNode[] {
  let start = 0;
  let end = nodes.length;
  while (start < end && blank(nodes[start] as RichTextNode)) start += 1;
  while (end > start && blank(nodes[end - 1] as RichTextNode)) end -= 1;
  return nodes.slice(start, end);
}

/** Nothing but pictures, however the editor wrapped them. */
function onlyPictures(node: RichTextNode): boolean {
  if ('type' in node) return false;
  if (node.name === 'img') return true;
  if (node.name !== 'p' && node.name !== 'div') return false;
  const children = node.children ?? [];
  return children.some(onlyPictures) && children.every((c) => blank(c) || onlyPictures(c));
}

/** The sanitiser's image style only caps the width: a narrow picture has to be stretched. */
function fullWidth(node: RichTextNode): RichTextNode {
  if ('type' in node) return node;
  if (node.name === 'img') {
    return { ...node, attrs: { ...node.attrs, style: `${node.attrs?.style ?? ''};width:100%` } };
  }
  return node.children ? { ...node, children: node.children.map(fullWidth) } : node;
}

/**
 * For content drawn with no side padding: pictures reach both edges, and each run of anything
 * else sits in one inset wrapper, so inline runs stay on their line. Blank runs between pictures
 * go, so a sliced long poster stays in one piece.
 */
function bleedPictures(nodes: readonly RichTextNode[]): RichTextNode[] {
  const out: RichTextNode[] = [];
  let text: RichTextNode[] = [];
  const flush = () => {
    if (!text.every(blank)) out.push({ name: 'div', attrs: { style: TEXT_INSET }, children: text });
    text = [];
  };
  for (const node of nodes) {
    if (onlyPictures(node)) {
      flush();
      out.push(fullWidth(node));
    } else {
      text.push(node);
    }
  }
  flush();
  return out;
}

export type RichTextBlockComponentProps = BlockProps<RichTextBlockProps> & {
  /** Pictures edge to edge, text keeping the gutter. The caller draws no side padding. */
  bleed?: boolean | undefined;
};

/**
 * 富文本: the operator's text, from HTML that the server sanitised on save and
 * again on serve (DECOR-017). Parsing here goes through the same allow-list
 * a third time and yields the node list `<rich-text>` draws — no HTML string
 * ever reaches the renderer.
 */
export function RichText({ props, host, bleed = false }: RichTextBlockComponentProps) {
  const resolve = host?.resolveImage;
  const nodes = useMemo(() => {
    const drawn = styled(trimBlank(parseRichText(props.html)), resolve);
    return bleed ? bleedPictures(drawn) : drawn;
  }, [props.html, resolve, bleed]);
  return (
    <BlockFrame type="richText" frame={props.style} className={styles.body}>
      <NativeRichText className={styles.content} nodes={nodes} />
    </BlockFrame>
  );
}
