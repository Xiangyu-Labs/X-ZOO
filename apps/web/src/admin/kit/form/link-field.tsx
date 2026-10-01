'use client';

import { LinkOutlined } from '@ant-design/icons';
import { Button, Input, Space } from 'antd';
import { useState } from 'react';

import { LinkPicker } from '../link/link-picker';
import type { LinkTargetType, LinkValue } from '../link/types';
import { defined } from '../props';

export interface LinkFieldProps {
  value?: LinkValue | undefined;
  onChange?: (value: LinkValue | undefined) => void;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  allow?: readonly LinkTargetType[] | undefined;
  id?: string | undefined;
}

/**
 * Form field wrapping `<LinkPicker>`. The value is the whole
 * `{ type, label, url }`, which is what banners and DIY components store.
 *
 * ```tsx
 * { kind: 'link', name: 'target', label: '跳转链接' }
 * ```
 */
export function LinkField({
  value,
  onChange,
  disabled = false,
  placeholder = '未选择链接',
  allow,
  id,
}: LinkFieldProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          {...defined({ id })}
          readOnly
          disabled={disabled}
          value={value ? `${value.label} · ${value.url}` : ''}
          placeholder={placeholder}
          allowClear
          onChange={(event) => {
            if (event.target.value === '') onChange?.(undefined);
          }}
        />
        <Button icon={<LinkOutlined />} disabled={disabled} onClick={() => setOpen(true)}>
          选择
        </Button>
      </Space.Compact>

      <LinkPicker
        open={open}
        onClose={() => setOpen(false)}
        onSelect={(next) => onChange?.(next)}
        value={value}
        {...(allow ? { allow } : {})}
      />
    </>
  );
}
