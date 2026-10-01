import { describe, expect, it } from 'vitest';
import { validateReplyPayload } from './wechat-oa.reply.service';

/**
 * A reply body that cannot be rendered is worse than no reply: the send path
 * silently does nothing, and the operator's only evidence that it worked is the
 * success toast.
 */
describe('validateReplyPayload', () => {
  it('accepts the shapes WeChat can render', () => {
    expect(() => validateReplyPayload('text', { text: '你好' })).not.toThrow();
    expect(() => validateReplyPayload('image', { mediaId: 'MEDIA_1' })).not.toThrow();
    expect(() => validateReplyPayload('voice', { mediaId: 'MEDIA_1' })).not.toThrow();
    expect(() =>
      validateReplyPayload('video', { mediaId: 'MEDIA_1', title: '开箱' }),
    ).not.toThrow();
    expect(() =>
      validateReplyPayload('news', {
        articles: [
          { title: '新品', description: '', url: 'https://shop.example.com/', picUrl: '' },
        ],
      }),
    ).not.toThrow();
  });

  it('refuses a text reply of only whitespace', () => {
    expect(() => validateReplyPayload('text', { text: '   ' })).toThrow(/需要填写内容/);
    expect(() => validateReplyPayload('text', {})).toThrow(/需要填写内容/);
  });

  it('refuses a media reply with no handle', () => {
    expect(() => validateReplyPayload('image', {})).toThrow(/需要选择素材/);
    expect(() => validateReplyPayload('voice', { mediaId: ' ' })).toThrow(/需要选择素材/);
  });

  it('refuses a video with no title, which renders as an unnamed bubble', () => {
    expect(() => validateReplyPayload('video', { mediaId: 'MEDIA_1' })).toThrow(/需要填写标题/);
  });

  it('refuses a news reply with no articles', () => {
    expect(() => validateReplyPayload('news', { articles: [] })).toThrow(/至少需要一篇文章/);
    expect(() => validateReplyPayload('news', {})).toThrow(/至少需要一篇文章/);
  });
});
