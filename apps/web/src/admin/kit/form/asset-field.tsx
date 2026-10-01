'use client';

import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { useAssetPicker } from '../asset/asset-picker';
import { useAssetAccess } from '../asset/asset-source-context';
import type { AssetItem } from '../asset/types';
import { Thumbnail } from '../thumbnail';

/** What the form value holds. `url` is the default because that is what most contracts carry. */
export type AssetValueType = 'url' | 'id' | 'asset';

export interface AssetFieldProps {
  /** `string` / `string[]` for `url`/`id`, `AssetItem` / `AssetItem[]` for `asset`. */
  value?: unknown | undefined;
  onChange?: ((value: unknown) => void) | undefined;
  multiple?: boolean | undefined;
  /** Cap when `multiple`. */
  max?: number | undefined;
  valueType?: AssetValueType | undefined;
  disabled?: boolean | undefined;
  /** Thumbnail edge length in px. Default 96. */
  size?: number | undefined;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Image field backed by `<AssetPicker>`.
 *
 * `valueType` decides what lands in the form value:
 * - `'url'` (default) — the asset URL, which is what most contracts store
 * - `'id'`            — the asset id
 * - `'asset'`         — the whole contract `asset` object
 *
 * With `'id'` the component can only show a thumbnail for assets picked in this
 * session; give it `'url'` or `'asset'` when the page must render existing images.
 */
export function AssetField({
  value,
  onChange,
  multiple = false,
  max,
  valueType = 'url',
  disabled = false,
  size = 96,
}: AssetFieldProps) {
  const picker = useAssetPicker();
  // Without the library there is nothing to pick from: say so instead of
  // opening a picker that answers with 403 toasts.
  const access = useAssetAccess();
  // Remembers URLs for id-valued fields so a fresh pick still shows a preview.
  const [known, setKnown] = useState<Record<string, string>>({});

  const entries = useMemo(() => {
    return toArray(value).map((item) => {
      if (valueType === 'asset') {
        const asset = item as AssetItem;
        return { key: asset.id, url: asset.url, raw: item };
      }
      const str = String(item);
      return {
        key: str,
        url: valueType === 'url' ? str : (known[str] ?? ''),
        raw: item,
      };
    });
  }, [value, valueType, known]);

  const emit = (assets: AssetItem[]): void => {
    const mapped = assets.map((asset) =>
      valueType === 'asset' ? asset : valueType === 'id' ? asset.id : asset.url,
    );
    if (valueType === 'id') {
      setKnown((prev) => {
        const next = { ...prev };
        for (const asset of assets) next[asset.id] = asset.url;
        return next;
      });
    }
    onChange?.(multiple ? mapped : (mapped[0] ?? undefined));
  };

  const openPicker = async (): Promise<void> => {
    const held = entries.flatMap((entry) => (entry.url ? [entry.key, entry.url] : [entry.key]));
    const remaining = max !== undefined ? Math.max(0, max - entries.length) : undefined;
    const picked = await picker.pick({
      multiple,
      ...(remaining !== undefined ? { max: remaining } : {}),
      // What the field already shows is not offered again (轮播图 twice the same picture).
      ...(multiple ? { taken: held } : {}),
    });
    if (picked.length === 0) return;
    if (!multiple) {
      emit(picked.slice(0, 1));
      return;
    }
    const existing = toArray(value);
    const holds = new Set(held);
    const merged = [
      ...existing.map((item) =>
        valueType === 'asset'
          ? (item as AssetItem)
          : ({ id: String(item), url: String(item), name: '', mime: '', size: 0 } as AssetItem),
      ),
      ...picked.filter((asset) => !holds.has(asset.id) && !holds.has(asset.url)),
    ];
    emit(max !== undefined ? merged.slice(0, max) : merged);
  };

  const removeAt = (index: number): void => {
    const next = toArray(value).filter((_item, i) => i !== index);
    onChange?.(multiple ? next : undefined);
  };

  const canAdd =
    !disabled && (multiple ? max === undefined || entries.length < max : entries.length === 0);

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {entries.map((entry, index) => (
        <div
          key={`${entry.key}-${index}`}
          style={{
            position: 'relative',
            width: size,
            height: size,
            borderRadius: 6,
            overflow: 'hidden',
            border: '1px solid var(--ant-color-border)',
            background: 'var(--ant-color-fill-quaternary)',
          }}
        >
          {entry.url ? (
            <Thumbnail src={entry.url} size={size - 2} radius={0} />
          ) : (
            <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 4 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                #{entry.key}
              </Typography.Text>
            </div>
          )}
          {disabled ? null : (
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label="移除"
              onClick={() => removeAt(index)}
              // Above the thumbnail's preview cover.
              style={{ position: 'absolute', insetInlineEnd: 0, insetBlockStart: 0, zIndex: 2 }}
            />
          )}
        </div>
      ))}

      {canAdd && !access.list ? (
        <Typography.Text type="secondary" data-testid="asset-field-no-access">
          没有素材库权限，无法选择图片
        </Typography.Text>
      ) : null}

      {canAdd && access.list ? (
        <button
          type="button"
          onClick={() => openPicker()}
          data-testid="asset-field-add"
          style={{
            width: size,
            height: size,
            borderRadius: 6,
            border: '1px dashed var(--ant-color-border)',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--ant-color-text-secondary)',
          }}
        >
          <PlusOutlined />
          <div style={{ fontSize: 12, marginTop: 4 }}>选择图片</div>
        </button>
      ) : null}

      {picker.holder}
    </div>
  );
}
