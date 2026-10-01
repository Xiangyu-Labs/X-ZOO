import { describe, expect, it } from 'vitest';
import { extractLinks } from './links';

describe('extractLinks', () => {
  it('lists http(s) links once each, with their text', () => {
    const html =
      '<p>见 <a href="https://mp.weixin.qq.com/s/abc">公众号<b>原文</b></a>，' +
      '<a href="javascript:alert(1)">x</a> <a href=\'https://example.com/a?x=1&amp;y=2\'></a>' +
      '<a href="https://mp.weixin.qq.com/s/abc">again</a></p>';
    expect(extractLinks(html)).toEqual([
      { href: 'https://mp.weixin.qq.com/s/abc', text: '公众号原文' },
      { href: 'https://example.com/a?x=1&y=2', text: 'https://example.com/a?x=1&y=2' },
    ]);
  });

  it('is empty without links', () => {
    expect(extractLinks('<p>纯文本</p>')).toEqual([]);
  });
});
