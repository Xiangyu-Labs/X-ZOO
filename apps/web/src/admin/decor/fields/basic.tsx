'use client';

import { PictureOutlined } from '@ant-design/icons';
import {
  Button,
  Checkbox,
  ColorPicker,
  Input,
  Segmented,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useState } from 'react';

import { AssetPicker } from '@/admin/kit/asset/asset-picker';
import type { ChoiceOption } from '../zod-to-puck';
import { FieldShell, metaOf, type DecorFieldProps } from './shell';

/**
 * The generic inspector controls: image, colour, choice (the spacing / radius
 * presets are choices), switch, multi-select, group heading and the fallback.
 */

// ─── image ───────────────────────────────────────────────────────────────────

export function ImageField({
  field,
  name,
  value,
  onChange,
  readOnly = false,
}: DecorFieldProps<string | undefined>) {
  const [open, setOpen] = useState(false);
  const { optional } = metaOf(field);
  return (
    <FieldShell field={field} name={name} readOnly={readOnly}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div
          style={{
            width: 64,
            height: 64,
            flex: 'none',
            borderRadius: 6,
            border: '1px solid var(--ant-color-border, #d9d9d9)',
            background: '#fafafa',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            color: '#bfbfbf',
          }}
        >
          {value ? (
            <img src={value} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <PictureOutlined style={{ fontSize: 20 }} />
          )}
        </div>
        <Space direction="vertical" size={4} style={{ flex: 1, minWidth: 0 }}>
          <Space size={4}>
            <Button size="small" disabled={readOnly} onClick={() => setOpen(true)}>
              {value ? '更换' : '选择图片'}
            </Button>
            {optional && value ? (
              <Button
                size="small"
                type="text"
                disabled={readOnly}
                onClick={() => onChange(undefined)}
              >
                清除
              </Button>
            ) : null}
          </Space>
          <Input
            size="small"
            value={value ?? ''}
            placeholder="或粘贴图片地址"
            disabled={readOnly}
            aria-label={`${field.label ?? name}地址`}
            onChange={(event) => {
              const next = event.target.value.trim();
              onChange(next === '' && optional ? undefined : next);
            }}
          />
        </Space>
      </div>
      <AssetPicker
        open={open}
        onClose={() => setOpen(false)}
        onSelect={(assets) => {
          const picked = assets[0];
          if (picked) onChange(picked.url);
          setOpen(false);
        }}
      />
    </FieldShell>
  );
}

// ─── video ───────────────────────────────────────────────────────────────────

/** Whether a picked asset is a video the mini-program's `<Video>` can play. */
export function isPlayableVideo(asset: { mime: string }): boolean {
  return asset.mime === 'video/mp4' || asset.mime === 'video/quicktime';
}

/**
 * A video from the 素材库 (mp4), or a pasted address. The preview is a muted,
 * paused `<video>` that only loads metadata, so the inspector never plays or
 * downloads the whole file. A pick that is not a video is refused with a
 * message rather than stored.
 */
export function VideoField({
  field,
  name,
  value,
  onChange,
  readOnly = false,
}: DecorFieldProps<string | undefined>) {
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const { optional } = metaOf(field);
  return (
    <FieldShell field={field} name={name} readOnly={readOnly}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        {value ? (
          <video
            src={value}
            muted
            preload="metadata"
            controls={false}
            data-testid="video-field-preview"
            style={{
              width: '100%',
              maxHeight: 120,
              borderRadius: 6,
              background: '#000',
              display: 'block',
            }}
          />
        ) : null}
        <Space size={4}>
          <Button size="small" disabled={readOnly} onClick={() => setOpen(true)}>
            {value ? '更换视频' : '选择视频'}
          </Button>
          {optional && value ? (
            <Button
              size="small"
              type="text"
              disabled={readOnly}
              onClick={() => onChange(undefined)}
            >
              清除
            </Button>
          ) : null}
        </Space>
        <Input
          size="small"
          value={value ?? ''}
          placeholder="或粘贴视频地址（mp4）"
          disabled={readOnly}
          aria-label={`${field.label ?? name}地址`}
          onChange={(event) => {
            setRefused(null);
            const next = event.target.value.trim();
            onChange(next === '' && optional ? undefined : next);
          }}
        />
        {refused ? (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {refused}
          </Typography.Text>
        ) : null}
      </Space>
      <AssetPicker
        open={open}
        title="选择视频"
        accept="video/mp4"
        onClose={() => setOpen(false)}
        onSelect={(assets) => {
          const picked = assets[0];
          if (picked && isPlayableVideo(picked)) {
            setRefused(null);
            onChange(picked.url);
          } else if (picked) {
            setRefused(`「${picked.name}」不是 mp4 视频，请另选`);
          }
          setOpen(false);
        }}
      />
    </FieldShell>
  );
}

// ─── colour ──────────────────────────────────────────────────────────────────

/** A restrained palette: neutrals, the brand's muted rose and a few soft tones. */
const COLOR_PRESETS = [
  {
    label: '常用',
    colors: [
      '#ffffff',
      '#f5f5f5',
      '#f7f3ef',
      '#1f1f1f',
      '#595959',
      '#8c8c8c',
      '#b76e79',
      '#e8d5d0',
      '#6d5b7b',
      '#d9cfe3',
      '#4a6572',
      '#c9d6df',
    ],
  },
];

export function ColorField({
  field,
  name,
  value,
  onChange,
  readOnly = false,
}: DecorFieldProps<string | undefined>) {
  const { optional } = metaOf(field);
  return (
    <FieldShell field={field} name={name} readOnly={readOnly}>
      <ColorPicker
        value={value ?? null}
        disabled={readOnly}
        showText
        allowClear={optional}
        format="hex"
        presets={COLOR_PRESETS}
        onChangeComplete={(color) => onChange(color.toHexString())}
        onClear={() => onChange(undefined)}
      />
    </FieldShell>
  );
}

// ─── choice ──────────────────────────────────────────────────────────────────

/** Values may be numbers (`1 | 2`): the controls key options by position. */
function indexOf(options: readonly ChoiceOption[], value: unknown): string | undefined {
  const index = options.findIndex((option) => option.value === value);
  return index === -1 ? undefined : String(index);
}

export function ChoiceField({
  field,
  name,
  value,
  onChange,
  readOnly = false,
}: DecorFieldProps<string | number | boolean | undefined>) {
  const { options = [], control, optional } = metaOf(field);
  const current = indexOf(options, value);
  const pick = (key: string | undefined) =>
    onChange(key === undefined ? undefined : options[Number(key)]?.value);
  return (
    <FieldShell field={field} name={name} readOnly={readOnly}>
      {control === 'radio' ? (
        <Segmented
          block
          size="small"
          disabled={readOnly}
          value={current ?? ''}
          options={options.map((option, index) => ({ label: option.label, value: String(index) }))}
          onChange={(key) => pick(String(key))}
        />
      ) : (
        <Select<string>
          style={{ width: '100%' }}
          size="small"
          disabled={readOnly}
          allowClear={optional}
          {...(current !== undefined ? { value: current } : {})}
          options={options.map((option, index) => ({ label: option.label, value: String(index) }))}
          onChange={(key) => pick(key)}
        />
      )}
    </FieldShell>
  );
}

// ─── switch ──────────────────────────────────────────────────────────────────

export function SwitchField({
  field,
  name,
  value,
  onChange,
  readOnly = false,
}: DecorFieldProps<boolean | undefined>) {
  return (
    <FieldShell field={field} name={name} readOnly={readOnly}>
      <Switch
        size="small"
        checked={value === true}
        disabled={readOnly}
        aria-label={field.label ?? name}
        onChange={(checked) => onChange(checked)}
      />
    </FieldShell>
  );
}

// ─── multi-select ────────────────────────────────────────────────────────────

export function MultiChoiceField({
  field,
  name,
  value,
  onChange,
  readOnly = false,
}: DecorFieldProps<(string | number | boolean)[] | undefined>) {
  const { options = [], max } = metaOf(field);
  const chosen = new Set(value ?? []);
  const full = max !== undefined && chosen.size >= max;
  return (
    <FieldShell field={field} name={name} readOnly={readOnly}>
      <Checkbox.Group
        disabled={readOnly}
        value={options.flatMap((option, index) =>
          chosen.has(option.value) ? [String(index)] : [],
        )}
        options={options.map((option, index) => ({
          label: option.label,
          value: String(index),
          disabled: full && !chosen.has(option.value),
        }))}
        onChange={(keys) =>
          // In the options' order, whatever order they were ticked in.
          onChange(
            options.filter((_option, index) => keys.includes(String(index))).map((o) => o.value),
          )
        }
      />
    </FieldShell>
  );
}

// ─── group heading ───────────────────────────────────────────────────────────

/** A pseudo field: draws the heading of the fields that follow. Holds no value. */
export function GroupHeading({ field }: DecorFieldProps<unknown>) {
  return (
    <div
      data-decor-group={field.label}
      style={{
        margin: '4px 0 -4px',
        paddingTop: 8,
        borderTop: '1px solid var(--puck-color-grey-09, #f0f0f0)',
        fontSize: 12,
        fontWeight: 600,
        color: '#8c8c8c',
        letterSpacing: 1,
      }}
    >
      {field.label}
    </div>
  );
}

// ─── fallback ────────────────────────────────────────────────────────────────

/** A read-only view of a prop the editor has no control for. */
export function UnsupportedField({ field, name, value }: DecorFieldProps<unknown>) {
  return (
    <FieldShell field={field} name={name} readOnly>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(value, null, 2)}
        </pre>
      </Typography.Paragraph>
    </FieldShell>
  );
}
