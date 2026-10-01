'use client';

import { Input, Space } from 'antd';
import type {
  WechatMediaKind,
  WechatQrcodeStatus,
  WechatReplyArticle,
  WechatReplyMatchMode,
  WechatReplyPayload,
  WechatReplyTrigger,
  WechatReplyType,
} from '@shop/contracts/wechat-oa/schemas';

import type { FieldSpec } from '@/admin/kit/form/types';
import type { StatusMap } from '@/admin/kit/status-tag';
import { MediaSelect } from '@/admin/wechat-oa/media-select';

/**
 * The Official Account enums and the reply-body fields, in one file next to the
 * pages that share them.
 *
 * One `StatusMap` per contract enum, keyed by the contract's own union, so
 * dropping a value from the contract is a compile error here rather than a
 * blank tag in production.
 *
 * The reply body is shared on purpose: an auto-reply and a channel code's
 * greeting are the same five shapes, and two hand-written forms would disagree
 * about which of them needed a media id.
 */

export const REPLY_TRIGGER: StatusMap<WechatReplyTrigger> = {
  subscribe: { label: '关注时回复', color: 'success' },
  keyword: { label: '关键词回复', color: 'processing' },
  default: { label: '收到消息回复', color: 'default' },
};

export const REPLY_MATCH_MODE: StatusMap<WechatReplyMatchMode> = {
  exact: { label: '完全匹配', color: 'default' },
  contains: { label: '包含即可', color: 'default' },
};

export const REPLY_TYPE: StatusMap<WechatReplyType> = {
  text: { label: '文字', color: 'default' },
  image: { label: '图片', color: 'blue' },
  voice: { label: '语音', color: 'purple' },
  video: { label: '视频', color: 'geekblue' },
  news: { label: '图文', color: 'gold' },
};

export const MEDIA_KIND: StatusMap<WechatMediaKind> = {
  image: { label: '图片', color: 'blue' },
  voice: { label: '语音', color: 'purple' },
  video: { label: '视频', color: 'geekblue' },
  thumb: { label: '缩略图', color: 'default' },
  news: { label: '图文', color: 'gold' },
};

export const QRCODE_STATUS: StatusMap<WechatQrcodeStatus> = {
  active: { label: '启用中', color: 'success' },
  disabled: { label: '已停用', color: 'default' },
};

/**
 * One line describing a reply, for the list column.
 *
 * A table row that only says 图片 tells an operator nothing about *which*
 * reply they are looking at, and opening five edit dialogs to find the right
 * one is not a way to use a screen.
 */
export function replySummary(
  replyType: WechatReplyType | null,
  payload: WechatReplyPayload | null,
): string {
  if (replyType === null || payload === null) return '—';
  switch (replyType) {
    case 'text':
      return payload.text ?? '（空）';
    case 'news': {
      const articles = payload.articles ?? [];
      if (articles.length === 0) return '（没有文章）';
      const first = articles[0]?.title ?? '';
      return articles.length === 1 ? first : `${first} 等 ${articles.length} 篇`;
    }
    default:
      return payload.mediaId ? `素材 ${payload.mediaId}` : '（未选择素材）';
  }
}

/**
 * The fields for one reply body.
 *
 * `prefix` is the key the payload sits under — `payload` for an auto-reply,
 * `replyPayload` for a channel code. Names are arrays rather than dotted
 * strings so the form's key type stays the contract's own top-level keys.
 *
 * Media is picked from the shop's own WeChat material, never typed in. A
 * hand-typed `media_id` is how an operator produces a reply that fails
 * silently in a customer's chat: WeChat answers `40007 invalid media_id` to the
 * *reply*, minutes after this form said 已保存, and nothing on this screen ever
 * says so.
 */
export function replyBodyFields<N extends string>(
  prefix: 'payload' | 'replyPayload',
): FieldSpec<N>[] {
  const at = (key: string) => [prefix, key];
  const isType =
    (...types: WechatReplyType[]) =>
    (values: Record<string, unknown>) => {
      const current = values['replyType'];
      return typeof current === 'string' && types.includes(current as WechatReplyType);
    };
  const mediaField = (kind: WechatMediaKind, label: string): FieldSpec<N> => ({
    kind: 'custom',
    name: at('mediaId'),
    label,
    span: 24,
    visibleWhen: isType(kind as WechatReplyType),
    render: ({ value, onChange, disabled }) => (
      <MediaSelect
        kind={kind}
        value={typeof value === 'string' ? value : undefined}
        onChange={onChange}
        disabled={disabled}
      />
    ),
  });

  return [
    {
      kind: 'textarea',
      name: at('text'),
      label: '回复内容',
      span: 24,
      rows: 4,
      maxLength: 2048,
      showCount: true,
      visibleWhen: isType('text'),
      help: '微信按纯文本原样发送，不支持排版。',
    },
    mediaField('image', '图片素材'),
    mediaField('voice', '语音素材'),
    mediaField('video', '视频素材'),
    {
      kind: 'text',
      name: at('title'),
      label: '视频标题',
      span: 12,
      maxLength: 128,
      visibleWhen: isType('video'),
    },
    {
      kind: 'text',
      name: at('description'),
      label: '视频描述',
      span: 12,
      maxLength: 512,
      visibleWhen: isType('video'),
    },
    {
      kind: 'sortableList',
      name: at('articles'),
      label: '图文',
      span: 24,
      max: 8,
      addText: '添加一篇',
      emptyText: '还没有文章，至少需要一篇。',
      help: '拖动排序，最多 8 篇；第一篇是大图。',
      visibleWhen: isType('news'),
      newItem: () => ({ title: '', description: '', url: '', picUrl: '' }),
      renderItem: (item, helpers) => {
        const article = item as WechatReplyArticle;
        const patch = (next: Partial<WechatReplyArticle>) =>
          helpers.update(next as Parameters<typeof helpers.update>[0]);
        return (
          <Space direction="vertical" style={{ width: '100%' }} size={4}>
            <Input
              value={article.title}
              placeholder="标题"
              disabled={helpers.disabled}
              onChange={(event) => patch({ title: event.target.value })}
            />
            <Input
              value={article.url}
              placeholder="点击后打开的链接"
              disabled={helpers.disabled}
              onChange={(event) => patch({ url: event.target.value })}
            />
            <Input
              value={article.picUrl}
              placeholder="封面图地址（可留空）"
              disabled={helpers.disabled}
              onChange={(event) => patch({ picUrl: event.target.value })}
            />
            <Input
              value={article.description}
              placeholder="摘要（可留空）"
              disabled={helpers.disabled}
              onChange={(event) => patch({ description: event.target.value })}
            />
          </Space>
        );
      },
    },
  ];
}
