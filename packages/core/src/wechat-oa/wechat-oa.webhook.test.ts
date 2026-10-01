import { describe, expect, it } from 'vitest';
import { parseXml } from './wechat-oa.crypto';
import { maskOpenid } from './wechat-oa.qrcode.service';
import { buildReplyXml, dedupeKey } from './wechat-oa.webhook.service';

/**
 * The two pure pieces of the callback: what makes two deliveries the same
 * delivery, and what the answer looks like on the wire.
 */

describe('dedupeKey', () => {
  it('uses MsgId when the callback carries one', () => {
    expect(dedupeKey({ MsgId: '24000000000000001', FromUserName: 'oABC' })).toBe(
      'wechat-oa:msg:24000000000000001',
    );
  });

  it('falls back to sender + time + event, because events carry no MsgId', () => {
    expect(dedupeKey({ FromUserName: 'oABC', CreateTime: '1767668400', Event: 'subscribe' })).toBe(
      'wechat-oa:evt:oABC:1767668400:subscribe',
    );
  });

  it('keeps a follow and the scan that caused it apart', () => {
    // They arrive a second apart and are genuinely two events; a key without the
    // event name would swallow the second one.
    const at = { FromUserName: 'oABC', CreateTime: '1767668400' };
    expect(dedupeKey({ ...at, Event: 'subscribe' })).not.toBe(dedupeKey({ ...at, Event: 'SCAN' }));
  });

  it('distinguishes two senders at the same second', () => {
    expect(dedupeKey({ FromUserName: 'oA', CreateTime: '1', Event: 'subscribe' })).not.toBe(
      dedupeKey({ FromUserName: 'oB', CreateTime: '1', Event: 'subscribe' }),
    );
  });
});

describe('buildReplyXml', () => {
  const head = { toUser: 'gh_1234567890ab', fromUser: 'oABC', createTime: 1_767_668_400 };

  it('swaps the sender and the recipient', () => {
    const parsed = parseXml(
      buildReplyXml({ ...head, reply: { replyType: 'text', payload: { text: '你好' } } }),
    );
    expect(parsed['ToUserName']).toBe('oABC');
    expect(parsed['FromUserName']).toBe('gh_1234567890ab');
    expect(parsed['CreateTime']).toBe('1767668400');
    expect(parsed['MsgType']).toBe('text');
    expect(parsed['Content']).toBe('你好');
  });

  it('wraps a media handle in the element its type wants', () => {
    expect(
      buildReplyXml({ ...head, reply: { replyType: 'image', payload: { mediaId: 'M1' } } }),
    ).toContain('<Image><MediaId><![CDATA[M1]]></MediaId></Image>');
    expect(
      buildReplyXml({ ...head, reply: { replyType: 'voice', payload: { mediaId: 'M1' } } }),
    ).toContain('<Voice><MediaId><![CDATA[M1]]></MediaId></Voice>');
    expect(
      buildReplyXml({
        ...head,
        reply: { replyType: 'video', payload: { mediaId: 'M1', title: '开箱', description: '' } },
      }),
    ).toContain('<Title><![CDATA[开箱]]></Title>');
  });

  it('renders at most 8 articles', () => {
    const article = (n: number) => ({
      title: `文章${n}`,
      description: '',
      url: 'https://shop.example.com/',
      picUrl: '',
    });
    const xml = buildReplyXml({
      ...head,
      reply: {
        replyType: 'news',
        payload: { articles: Array.from({ length: 12 }, (_, i) => article(i)) },
      },
    });
    expect(xml).toContain('<ArticleCount>8</ArticleCount>');
    expect(xml.match(/<item>/g)).toHaveLength(8);
  });

  it('answers `success` for a news reply with nothing in it', () => {
    // WeChat drops such a message silently; answering `success` at least leaves
    // the conversation in a state the customer can understand.
    expect(
      buildReplyXml({ ...head, reply: { replyType: 'news', payload: { articles: [] } } }),
    ).toBe('success');
  });
});

describe('maskOpenid', () => {
  it('shows four characters each end of a real openid', () => {
    expect(maskOpenid('oABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('oABC****WXYZ');
  });

  it('never returns a short openid in full', () => {
    expect(maskOpenid('oABC')).toBe('oA****');
  });

  it('passes null and empty through as null', () => {
    expect(maskOpenid(null)).toBeNull();
    expect(maskOpenid('')).toBeNull();
  });
});
