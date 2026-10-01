import { describe, expect, it } from 'vitest';

import { richTextProps } from './all-blocks';
import { checkDocument } from './document';
import {
  RICH_TEXT_IMAGE_STYLE,
  RICH_TEXT_LIMITS,
  decodeEntities,
  parseRichText,
  richTextPlainText,
  sanitizeRichText,
  sanitizeStyle,
} from './rich-text';

describe('the rich-text allow-list — DECOR-017', () => {
  it('keeps text structure and formatting', () => {
    const html =
      '<h2>须知</h2><p>所有商品<strong>隐私包装</strong>，<em>不</em>显示品名。</p>' +
      '<ul><li>一</li><li>二</li></ul><blockquote>引用</blockquote><p>a<br>b</p><hr>';
    expect(sanitizeRichText(html)).toBe(html);
  });

  it('drops scripts, styles, iframes, embeds and forms with everything inside them', () => {
    const html =
      '<p>a</p><script>alert(1)</script><style>p{display:none}</style>' +
      '<iframe src="https://evil.example"></iframe><object data="x">o</object><embed src="x">' +
      '<form><input value="x"><button>b</button></form><svg><script>1</script></svg>' +
      '<noscript>n</noscript><template>t</template><video src="v">v</video><p>b</p>';
    expect(sanitizeRichText(html)).toBe('<p>a</p><p>b</p>');
  });

  it('treats a script body as raw text, not markup', () => {
    expect(sanitizeRichText('<script>document.write("<p>x</p>")</script><p>y</p>')).toBe(
      '<p>y</p>',
    );
    expect(sanitizeRichText('<SCRIPT>x</SCRIPT >ok')).toBe('ok');
    // An unclosed script swallows the rest rather than letting it through.
    expect(sanitizeRichText('<p>a</p><script>alert(1)')).toBe('<p>a</p>');
  });

  it('strips every attribute but a filtered style, and event handlers above all', () => {
    expect(
      sanitizeRichText(
        '<p onclick="x()" class="c" id="i" data-x="1" style="color:#e1251b;position:fixed">t</p>',
      ),
    ).toBe('<p style="color:#e1251b">t</p>');
    expect(sanitizeRichText('<p style="">t</p>')).toBe('<p>t</p>');
  });

  it('keeps only the allowed style properties, with strict values', () => {
    expect(sanitizeStyle('color: red; text-align: center; font-weight: 700')).toBe(
      'color:red;text-align:center;font-weight:700',
    );
    expect(sanitizeStyle('background-color: rgb(255, 0, 0) !important')).toBe(
      'background-color:rgb(255, 0, 0)',
    );
    expect(sanitizeStyle('background: url(javascript:alert(1))')).toBe('');
    expect(sanitizeStyle('color: expression(alert(1))')).toBe('');
    expect(sanitizeStyle('color: red; width: 9999px; z-index: 99; font-size: 80px')).toBe(
      'color:red',
    );
    expect(sanitizeStyle('text-decoration: underline')).toBe('text-decoration:underline');
  });

  it('unwraps links and unknown tags, keeping their text', () => {
    expect(sanitizeRichText('<p><a href="javascript:alert(1)">点我</a></p>')).toBe('<p>点我</p>');
    expect(sanitizeRichText('<section><font color="red">x</font></section>')).toBe('x');
  });

  it('keeps https and site images only, with a fixed style that fits the screen', () => {
    expect(sanitizeRichText('<img src="https://cdn.example.com/a.jpg" style="width:2000px">')).toBe(
      `<img src="https://cdn.example.com/a.jpg" style="${RICH_TEXT_IMAGE_STYLE}">`,
    );
    expect(sanitizeRichText('<img src="/uploads/a.jpg" alt="图">')).toBe(
      `<img src="/uploads/a.jpg" alt="图" style="${RICH_TEXT_IMAGE_STYLE}">`,
    );
    for (const src of [
      'http://cdn.example.com/a.jpg',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      '//evil.example/a.jpg',
      'https://x.example/a.jpg" onerror="alert(1)',
    ]) {
      expect(sanitizeRichText(`<p>a<img src='${src}'></p>`)).toBe('<p>a</p>');
    }
    expect(sanitizeRichText('<img onerror="alert(1)">')).toBe('');
  });

  it('never lets markup out of text or attribute values', () => {
    expect(sanitizeRichText('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(sanitizeRichText('a < b > c')).toBe('a &lt; b &gt; c');
    expect(sanitizeRichText('<p title="x"><!-- <script>x</script> -->t</p>')).toBe('<p>t</p>');
    expect(sanitizeRichText('<!DOCTYPE html><p>t</p>')).toBe('<p>t</p>');
    expect(sanitizeRichText('<img alt="&quot;><script>" src="/a.jpg">')).toBe(
      `<img src="/a.jpg" alt="&quot;&gt;&lt;script&gt;" style="${RICH_TEXT_IMAGE_STYLE}">`,
    );
  });

  it('closes what was left open and ignores stray end tags', () => {
    expect(sanitizeRichText('<p><strong>a</p>b</strong>')).toBe('<p><strong>a</strong></p>b');
    expect(sanitizeRichText('</div>a')).toBe('a');
  });

  it('is idempotent: sanitising clean output changes nothing', () => {
    const inputs = [
      '<p style="color:red; font-size: 40px">a &amp; b</p><img src="/a.jpg">',
      '<ul><li><em>x<li>y</ul><script>z</script>',
      '<p>&nbsp;&#x4e2d;&#20013;&copy;&unknown;</p>',
    ];
    for (const input of inputs) {
      const once = sanitizeRichText(input);
      expect(sanitizeRichText(once)).toBe(once);
    }
  });

  it('decodes entities, never into a NUL or a lone surrogate', () => {
    expect(decodeEntities('&lt;&#x4e2d;&#20013;&nbsp;&bogus;')).toBe('<中中 &bogus;');
    expect(decodeEntities('&#0;&#xd800;&#x110000;')).toBe('');
  });

  it('caps the node count and the nesting depth', () => {
    const many = '<p>x</p>'.repeat(RICH_TEXT_LIMITS.nodes);
    const nodes = parseRichText(many);
    const count = (list: typeof nodes): number =>
      list.reduce((sum, node) => sum + 1 + ('type' in node ? 0 : count(node.children ?? [])), 0);
    expect(count(nodes)).toBeLessThanOrEqual(RICH_TEXT_LIMITS.nodes);

    const deep = '<div>'.repeat(40) + 'deep' + '</div>'.repeat(40);
    const depth = (list: typeof nodes): number =>
      Math.max(0, ...list.map((node) => ('type' in node ? 0 : 1 + depth(node.children ?? []))));
    const parsed = parseRichText(deep);
    expect(depth(parsed)).toBe(RICH_TEXT_LIMITS.depth);
    expect(richTextPlainText(parsed)).toBe('deep');
  });

  it('gives the nodes WeChat rich-text takes', () => {
    expect(parseRichText('<p style="text-align:center">a<br>b</p>')).toEqual([
      {
        name: 'p',
        attrs: { style: 'text-align:center' },
        children: [
          { type: 'text', text: 'a' },
          { name: 'br', attrs: {} },
          { type: 'text', text: 'b' },
        ],
      },
    ]);
  });

  it('is applied by the block schema, so a save stores only the clean form', () => {
    expect(richTextProps.parse({ html: '<p onclick="x">a</p><script>b</script>' }).html).toBe(
      '<p>a</p>',
    );
    const result = checkDocument({
      schemaVersion: 2,
      root: { props: { title: '页' } },
      blocks: [
        {
          id: 'r',
          type: 'richText',
          v: 1,
          props: { html: '<iframe src="https://x.example"></iframe><p>ok</p>' },
        },
      ],
    });
    if (!result.ok) throw new Error('refused');
    expect(result.issues).toEqual([]);
    expect(result.document.blocks[0]?.props.html).toBe('<p>ok</p>');
  });

  it('refuses a document too long to store', () => {
    const result = richTextProps.safeParse({ html: 'x'.repeat(RICH_TEXT_LIMITS.htmlLength + 1) });
    expect(result.success).toBe(false);
  });
});
