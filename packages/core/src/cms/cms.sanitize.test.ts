import { describe, expect, it } from 'vitest';
import { isSafeUrl, sanitizeHtml } from './cms.sanitize';

/**
 * The sanitiser's table. Every row is something an escape-on-save,
 * unescape-on-read pair would store and serve verbatim, because the two cancel
 * out.
 */

describe('sanitizeHtml', () => {
  it('keeps the editor output an operator actually writes', () => {
    const input =
      '<p>活动时间：<strong>11 月 1 日</strong></p><ul><li>满 199 减 20</li></ul>' +
      '<img src="/uploads/2026/10/a.png" alt="海报" />';
    expect(sanitizeHtml(input)).toBe(input);
  });

  it.each([
    ['<script>alert(1)</script>', ''],
    ['<p>前</p><script>alert(1)</script><p>后</p>', '<p>前</p><p>后</p>'],
    ['<style>body{display:none}</style>', ''],
    ['<iframe src="https://evil.test"></iframe>', ''],
    ['<object data="x"></object>', ''],
    ['<!--[if IE]><script>alert(1)</script><![endif]-->', ''],
  ])('drops %s along with its content', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected);
  });

  it('drops event handlers but keeps the element', () => {
    expect(sanitizeHtml('<p onclick="alert(1)" class="lead">文字</p>')).toBe(
      '<p class="lead">文字</p>',
    );
    expect(sanitizeHtml('<img src="/a.png" onerror="alert(1)" />')).toBe('<img src="/a.png" />');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java&#x09;script:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
  ])('drops the dangerous URL %s', (url) => {
    expect(sanitizeHtml(`<a href="${url}">点我</a>`)).toBe('<a>点我</a>');
  });

  it.each([
    'https://example.test/a',
    'http://example.test/a',
    '/uploads/a.png',
    'uploads/a.png',
    'data:image/png;base64,iVBORw0KGgo=',
  ])('keeps the safe URL %s', (url) => {
    expect(isSafeUrl(url)).toBe(true);
  });

  it('adds noopener to a link that opens a new tab', () => {
    expect(sanitizeHtml('<a href="https://example.test" target="_blank">外链</a>')).toBe(
      '<a href="https://example.test" target="_blank" rel="noopener noreferrer">外链</a>',
    );
  });

  it('refuses a style declaration that can fetch or execute', () => {
    expect(sanitizeHtml('<p style="color:red">红</p>')).toBe('<p style="color:red">红</p>');
    expect(sanitizeHtml('<p style="background:url(https://evil.test/x)">x</p>')).toBe('<p>x</p>');
    expect(sanitizeHtml('<p style="width:expression(alert(1))">x</p>')).toBe('<p>x</p>');
  });

  it('escapes text and closes what the editor left open', () => {
    expect(sanitizeHtml('5 < 6 & 7 > 3')).toBe('5 &lt; 6 &amp; 7 &gt; 3');
    expect(sanitizeHtml('<p>没有收尾')).toBe('<p>没有收尾</p>');
    expect(sanitizeHtml('</p>孤立的收尾')).toBe('孤立的收尾');
  });

  it('drops an unknown tag but keeps its text', () => {
    expect(sanitizeHtml('<marquee>跑马灯</marquee>')).toBe('跑马灯');
    expect(sanitizeHtml('<form><input name="x" /></form>')).toBe('');
  });

  it('leaves an empty body empty', () => {
    expect(sanitizeHtml('')).toBe('');
  });

  it.each([
    '<p>A &amp; B &lt;b&gt; 价格&nbsp;¥9 &ldquo;引号&rdquo; &#39;</p>',
    '<img src="/uploads/a.png?w=1&amp;h=2" alt="&quot;海报&quot;" />',
    '<a href="https://example.test" target="_blank" rel="noopener noreferrer">外链</a>',
    '<p>5 &lt; 6 &amp; 7 &gt; 3</p>',
  ])(
    'CMS-001 — a second pass changes nothing (the editor saves back what it loaded): %s',
    (html) => {
      const once = sanitizeHtml(html);
      expect(sanitizeHtml(once)).toBe(once);
      expect(once).not.toContain('&amp;amp;');
      expect(once.match(/rel=/g) ?? []).toHaveLength(html.includes('rel=') ? 1 : 0);
    },
  );

  it('CMS-001 — judges an attribute by what the browser decodes, not by its spelling', () => {
    // `&amp;` in a URL is `&`, written back once.
    expect(sanitizeHtml('<img src="/a.png?x=1&amp;y=2" />')).toBe(
      '<img src="/a.png?x=1&amp;y=2" />',
    );
    // A named reference the sanitiser does not decode stays literal text, so it
    // can never become the `:` of a `javascript:` the check did not see.
    expect(sanitizeHtml('<a href="javascript&colon;alert(1)">x</a>')).toBe(
      '<a href="javascript&amp;colon;alert(1)">x</a>',
    );
    // No code point, no 500.
    expect(sanitizeHtml('<img src="/a.png" alt="&#99999999;" />')).toBe(
      '<img src="/a.png" alt="" />',
    );
  });
});
