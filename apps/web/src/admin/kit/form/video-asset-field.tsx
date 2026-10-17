'use client';

import { PlusOutlined } from '@ant-design/icons';
import { Button, Form, Input, Space, Typography } from 'antd';
import { useState } from 'react';

import { useAssetPicker } from '../asset/asset-picker';
import { useAssetAccess } from '../asset/asset-source-context';
import { isPlayableVideo, VideoThumb } from '../asset/video-preview';
import { toNamePath, type FieldName } from './types';

export interface VideoAssetFieldProps {
  /** The video's URL. */
  value?: string | null | undefined;
  onChange?: ((value: string | undefined) => void) | undefined;
  disabled?: boolean | undefined;
  /** Shown over the video until it plays (a 封面 field next to this one). */
  poster?: string | null | undefined;
  /** Thumbnail width in px; the height is 9/16 of it. Default 192. */
  width?: number | undefined;
  /** Accessible name of the thumbnail and title of the player. */
  label?: string | undefined;
}

/**
 * One mp4 picked from the 素材库, shown as its cover with ▶; a click plays it.
 * 更换 picks another, 移除 clears the field, and an address can be pasted for a
 * video kept elsewhere.
 */
export function VideoAssetField({
  value,
  onChange,
  disabled = false,
  poster,
  width = 192,
  label = '视频',
}: VideoAssetFieldProps) {
  const picker = useAssetPicker();
  const access = useAssetAccess();
  const [refused, setRefused] = useState<string | null>(null);
  const height = Math.round((width * 9) / 16);

  const pick = async (): Promise<void> => {
    const [picked] = await picker.pick({ title: '选择视频', accept: 'video/mp4' });
    if (!picked) return;
    if (!isPlayableVideo(picked)) {
      setRefused(`「${picked.name}」不是 mp4 视频，请另选`);
      return;
    }
    setRefused(null);
    onChange?.(picked.url);
  };

  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {value ? (
        <VideoThumb src={value} poster={poster} width={width} height={height} name={label} />
      ) : !disabled && access.list ? (
        <button
          type="button"
          onClick={() => pick()}
          data-testid="video-field-add"
          style={{
            width,
            height,
            borderRadius: 6,
            border: '1px dashed var(--ant-color-border)',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--ant-color-text-secondary)',
          }}
        >
          <PlusOutlined />
          <div style={{ fontSize: 12, marginTop: 4 }}>选择视频</div>
        </button>
      ) : null}
      {!value && !disabled && !access.list ? (
        <Typography.Text type="secondary">没有素材库权限，无法选择视频</Typography.Text>
      ) : null}
      {value && !disabled ? (
        <Space size={4}>
          {access.list ? (
            <Button size="small" onClick={() => pick()}>
              更换视频
            </Button>
          ) : null}
          <Button
            size="small"
            type="text"
            danger
            aria-label={`移除${label}`}
            onClick={() => {
              setRefused(null);
              onChange?.(undefined);
            }}
          >
            移除
          </Button>
        </Space>
      ) : null}
      <Input
        size="small"
        value={value ?? ''}
        placeholder="或粘贴视频地址（mp4）"
        disabled={disabled}
        aria-label={`${label}地址`}
        style={{ maxWidth: 360 }}
        onChange={(event) => {
          setRefused(null);
          const next = event.target.value.trim();
          onChange?.(next === '' ? undefined : next);
        }}
      />
      {refused ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          {refused}
        </Typography.Text>
      ) : null}
      {picker.holder}
    </Space>
  );
}

/**
 * The form kit's `video` field: a `VideoAssetField` that shows the cover another
 * field of the same form holds (`posterName`) as soon as it is picked.
 */
export function VideoFormField({
  posterName,
  ...props
}: Omit<VideoAssetFieldProps, 'poster'> & { posterName?: FieldName | undefined }) {
  const form = Form.useFormInstance();
  const poster = Form.useWatch((values: Record<string, unknown> | undefined) => {
    if (posterName === undefined || values === undefined) return undefined;
    let at: unknown = values;
    for (const key of toNamePath(posterName)) {
      at = at && typeof at === 'object' ? (at as Record<string | number, unknown>)[key] : undefined;
    }
    return typeof at === 'string' && at !== '' ? at : undefined;
  }, form);
  return <VideoAssetField {...props} poster={poster} />;
}
