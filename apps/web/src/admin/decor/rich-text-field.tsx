'use client';

import { AutoField, FieldLabel, type CustomFieldRender } from '@puckeditor/core';
import { RICH_TEXT_LIMITS } from '@shop/storefront-blocks/schema';
import { Typography } from 'antd';

/**
 * The 富文本 control (`field: 'richText'`): Puck's own rich-text editor
 * (TipTap) in the inspector, trimmed to what the storefront keeps. Links and
 * code are switched off — the allow-list (DECOR-017) drops links anyway, and
 * a shop page has no use for code. What the editor produces is HTML; the
 * schema sanitises it on save and the resolver again on serve, so nothing
 * here is trusted.
 *
 * Inline editing on the canvas stays off: the canvas draws the storefront's
 * own `RichText` block, exactly as the shopper sees it.
 */

type RenderProps<Value> = Parameters<CustomFieldRender<Value>>[0];

export const RICH_TEXT_FIELD = {
  type: 'richtext',
  contentEditable: false,
  initialHeight: 220,
  options: {
    link: false,
    code: false,
    codeBlock: false,
    heading: { levels: [2, 3, 4] },
  },
} as const;

export function RichTextField({
  field,
  name,
  id,
  value,
  onChange,
  readOnly = false,
}: RenderProps<string | undefined>) {
  const length = value?.length ?? 0;
  const over = length > RICH_TEXT_LIMITS.htmlLength;
  return (
    <FieldLabel label={field.label ?? name} el="div" readOnly={readOnly}>
      <AutoField
        field={RICH_TEXT_FIELD as never}
        id={id}
        value={value ?? ''}
        readOnly={readOnly}
        onChange={(next: unknown) => onChange(typeof next === 'string' ? next : '')}
      />
      <Typography.Text type={over ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
        {over ? '内容过长，' : ''}
        {length}/{RICH_TEXT_LIMITS.htmlLength}（含格式）。链接、脚本和不支持的格式保存时会被去除。
      </Typography.Text>
    </FieldLabel>
  );
}
