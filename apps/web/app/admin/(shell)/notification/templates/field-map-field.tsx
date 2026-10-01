'use client';

import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Input, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';

export interface FieldMapFieldProps {
  value?: Record<string, string> | undefined;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean | undefined;
  /** The event's placeholder names, shown as a hint under the rows. */
  variables: readonly string[];
}

type Row = [key: string, text: string];

/**
 * The WeChat field map: `first` → `您好，订单 {{orderNo}} 已支付`.
 *
 * ## Why a control and not a JSON textarea
 *
 * WeChat's field names are positional and template-specific (`first`,
 * `keyword1`, `remark` for an OA template; `thing3`, `amount5`,
 * `character_string2` for a subscribe one), and the value is our template
 * string. An operator copying those names out of 公众平台 into a JSON blob gets
 * one comma wrong and the whole channel silently stops — WeChat answers `47003`
 * and the send is skipped, which is exactly the failure this system exists to
 * stop being invisible.
 *
 * ## Why the rows are local state
 *
 * A half-typed row has an empty key, and an empty key cannot be a key in the
 * object that goes to the server — WeChat rejects the whole message for one.
 * So the rows live here as an array, where a blank line is an ordinary state
 * an operator is in the middle of, and only the complete pairs are published
 * upwards. Deriving the rows from the object instead would make pressing
 * 添加字段 do nothing at all, because the blank row would be dropped on the way
 * down and never come back.
 */
export function FieldMapField(props: FieldMapFieldProps) {
  const { value, onChange, variables } = props;
  // `exactOptionalPropertyTypes`: antd's props are `boolean`, not `boolean | undefined`.
  const disabled = props.disabled ?? false;
  const [rows, setRows] = useState<Row[]>(() => Object.entries(value ?? {}));

  // Re-seed only when the *incoming* object is a different one than what these
  // rows last produced — e.g. the form was reset. Without the guard every
  // keystroke would bounce back through `value` and lose the caret.
  const published = useRef<string>(JSON.stringify(toObject(rows)));
  useEffect(() => {
    const incoming = JSON.stringify(value ?? {});
    if (incoming === published.current) return;
    published.current = incoming;
    setRows(Object.entries(value ?? {}));
  }, [value]);

  const write = (next: Row[]): void => {
    setRows(next);
    const object = toObject(next);
    published.current = JSON.stringify(object);
    onChange(object);
  };

  return (
    <div>
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        {rows.map(([key, text], index) => (
          <Space.Compact key={index} style={{ width: '100%' }}>
            <Input
              style={{ width: '32%' }}
              value={key}
              disabled={disabled}
              placeholder="微信字段名"
              onChange={(event) =>
                write(rows.map((row, at) => (at === index ? [event.target.value, row[1]] : row)))
              }
            />
            <Input
              value={text}
              disabled={disabled}
              placeholder="内容，可用 {{占位符}}"
              onChange={(event) =>
                write(rows.map((row, at) => (at === index ? [row[0], event.target.value] : row)))
              }
            />
            <Button
              icon={<DeleteOutlined />}
              disabled={disabled}
              aria-label="删除该字段"
              onClick={() => write(rows.filter((_, at) => at !== index))}
            />
          </Space.Compact>
        ))}

        <Button
          icon={<PlusOutlined />}
          disabled={disabled}
          onClick={() => write([...rows, ['', '']])}
        >
          添加字段
        </Button>
      </Space>

      {variables.length > 0 ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          可用占位符：{variables.map((name) => `{{${name}}}`).join('、')}
        </Typography.Paragraph>
      ) : null}
    </div>
  );
}

/** Complete pairs only, in the order the operator sees them. */
function toObject(rows: readonly Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, text] of rows) {
    const name = key.trim();
    if (name !== '') out[name] = text;
  }
  return out;
}
