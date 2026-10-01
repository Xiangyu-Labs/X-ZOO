'use client';

import { FieldLabel, type CustomFieldRender } from '@puckeditor/core';
import { Typography } from 'antd';
import type { ReactElement, ReactNode } from 'react';

import type { DecorFieldMetadata } from '../zod-to-puck';

/** What Puck hands a custom field's renderer. */
export type DecorFieldProps<Value> = Parameters<CustomFieldRender<Value>>[0];

export function metaOf(field: { metadata?: unknown }): DecorFieldMetadata {
  return (field.metadata as DecorFieldMetadata | undefined) ?? { meta: undefined, optional: false };
}

/** Puck's own label frame, plus the schema's `help` line under the control. */
export function FieldShell({
  field,
  name,
  readOnly,
  children,
}: {
  field: { label?: string | undefined; metadata?: unknown };
  name: string;
  readOnly?: boolean | undefined;
  children: ReactNode;
}): ReactElement {
  const help = metaOf(field).meta?.help;
  return (
    <FieldLabel label={field.label ?? name} el="div" readOnly={readOnly ?? false}>
      {children}
      {help ? (
        <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
          {help}
        </Typography.Text>
      ) : null}
    </FieldLabel>
  );
}
