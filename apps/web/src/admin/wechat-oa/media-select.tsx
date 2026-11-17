'use client';

import { Select, Space, Typography } from 'antd';
import { useDeferredValue, useState } from 'react';
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
 * The list is searched on the server rather than fetched as one page of 100: a
 * shop that has uploaded more than that could not pick the 101st asset, and
 * would also be told a perfectly good handle was "not in the library". The
 * chosen handle is looked up by its own id, so that warning only appears when
 * the asset really is gone (a temporary one WeChat expired).
 */
export function MediaSelect({ kind, value, onChange, disabled = false }: MediaSelectProps) {
  const [keyword, setKeyword] = useState('');
  const term = useDeferredValue(keyword);

  const list = useRouteQuery(wechatOaMediaList, {
    query: {
      page: 1,
      pageSize: 50,
      kind,
      ...(term === '' ? {} : { keyword: term }),
    },
  });
  const items = list.data?.items ?? [];

  // Where the current value's name and preview come from, even when it is not
  // in the page the search is showing.
  const selectedLookup = useRouteQuery(
    wechatOaMediaList,
    { query: { page: 1, pageSize: 10, kind, keyword: value ?? '' } },
    { enabled: value !== undefined, presentError: false },
  );
  const selected =
    value === undefined
      ? undefined
      : selectedLookup.data?.items.find((item) => item.mediaId === value);
  const missing =
    value !== undefined && selectedLookup.data !== undefined && selected === undefined;

  const visible =
    selected !== undefined && !items.some((item) => item.mediaId === value)
      ? [selected, ...items]
      : items;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={4}>
      <Select
        value={value}
        onChange={(next: string | undefined) => onChange?.(next)}
        loading={list.isPending}
        disabled={disabled}
        allowClear
        showSearch
        filterOption={false}
        onSearch={setKeyword}
        onOpenChange={(open) => {
          if (!open) setKeyword('');
        }}
        notFoundContent={
          list.isPending ? null : list.isError ? '素材加载失败，请重新输入以重试' : '没有匹配的素材'
        }
        placeholder="搜索并选择已上传到微信的素材"
        style={{ width: '100%' }}
        options={visible.map((item) => ({
          value: item.mediaId,
          label: `${item.mediaId}${item.isPermanent ? '' : '（临时）'}`,
        }))}
      />
      {/* An unknown handle is worth saying out loud: it is usually a temporary
          asset WeChat has already expired, and the reply would fail silently. */}
      {missing ? (
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
