'use client';

import { Select, Space, Typography } from 'antd';
import { wechatOaMediaList } from '@shop/contracts/wechat-oa/wechat-oa.media.contract';
import type { WechatMediaKind } from '@shop/contracts/wechat-oa/schemas';

import { useRouteQuery } from '@/admin/api/hooks';

export interface MediaSelectProps {
  /** Only material WeChat holds under this type can be sent as this reply. */
  kind: WechatMediaKind;
  value?: string | undefined;
  onChange?: ((value: string | undefined) => void) | undefined;
  disabled?: boolean | undefined;
}

/**
 * Picks a `media_id` out of the shop's own WeChat material.
 *
 * The value is WeChat's handle, because that is what a reply carries — but an
 * operator cannot be asked to know or type one. The list route is the same one
 * behind 微信素材, so anything uploaded there is immediately selectable here,
 * and a reply can only ever name material we have actually pushed to WeChat.
 *
 * One page of 100 is deliberately the whole widget: a shop with more permanent
 * assets than that has an organisation problem the picker cannot fix, and a
 * searchable select over 100 rows beats a paged modal for a field that is
 * filled in once.
 */
export function MediaSelect({ kind, value, onChange, disabled = false }: MediaSelectProps) {
  const { data, isPending } = useRouteQuery(wechatOaMediaList, {
    query: { page: 1, pageSize: 100, kind },
  });

  const items = data?.items ?? [];
  const selected = items.find((item) => item.mediaId === value);

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={4}>
      <Select
        value={value}
        onChange={(next: string | undefined) => onChange?.(next)}
        loading={isPending}
        disabled={disabled}
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="选择已上传到微信的素材"
        style={{ width: '100%' }}
        options={items.map((item) => ({
          value: item.mediaId,
          label: `${item.mediaId}${item.isPermanent ? '' : '（临时）'}`,
        }))}
        notFoundContent={isPending ? null : '还没有这种类型的素材，请先在「微信素材」里上传'}
      />
      {/* An unknown handle is worth saying out loud: it is usually a temporary
          asset WeChat has already expired, and the reply would fail silently. */}
      {value !== undefined && selected === undefined && !isPending ? (
        <Typography.Text type="warning">
          素材 {value} 不在当前素材库里，可能已过期，建议重新选择。
        </Typography.Text>
      ) : null}
      {selected?.url ? (
        kind === 'image' || kind === 'thumb' ? (
          <img
            src={selected.url}
            alt=""
            style={{ maxWidth: 160, maxHeight: 160, borderRadius: 4, display: 'block' }}
          />
        ) : (
          <Typography.Link href={selected.url} target="_blank" rel="noreferrer">
            预览
          </Typography.Link>
        )
      ) : null}
    </Space>
  );
}
