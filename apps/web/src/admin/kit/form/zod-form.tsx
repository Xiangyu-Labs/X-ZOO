'use client';

// Side-effect import: the contract's messages in plain Chinese on the client
// too (请填写此项, 最多 20 个字), not zod's English or its type-speak.
import '@shop/contracts/locale';
import { Button, Card, Col, Flex, Form, Row, type FormInstance } from 'antd';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { z } from 'zod';

import { ApiError } from '../../api/errors';
import { renderControl, valuePropNameOf } from './field-control';
import { FormErrorBanner, useFieldErrors } from './form-errors';
import { toNamePath, type FieldSpec } from './types';
import {
  applyZodIssues,
  fieldSchemaOf,
  isFieldRequired,
  normaliseFormValues,
  zodFieldRule,
} from './zod-bridge';
import { defined } from '../props';

type AnyObjectSchema = z.ZodObject<z.ZodRawShape>;

export interface ZodFormProps<S extends AnyObjectSchema> {
  /** The contract's body schema. It is the single source of truth for validation. */
  schema: S;
  /** Declarative field list. Order here is render order. */
  fields: readonly FieldSpec<Extract<keyof z.input<S>, string>>[];
  initialValues?: Partial<z.input<S>> | undefined;
  /** Receives the *parsed* value, so defaults and coercions have been applied. */
  onSubmit: (values: z.output<S>) => void | Promise<void>;
  /** Supply one when a parent (e.g. `ModalForm`) needs to call `form.submit()`. */
  form?: FormInstance | undefined;
  layout?: 'vertical' | 'horizontal' | undefined;
  /** Fields per row at `md` and up. Default 1. Per-field `span` overrides it. */
  columns?: 1 | 2 | 3 | undefined;
  disabled?: boolean | undefined;
  submitting?: boolean | undefined;
  submitText?: string | undefined;
  cancelText?: string | undefined;
  onCancel?: (() => void) | undefined;
  /** `false` hides the built-in buttons — what `ModalForm`/`DrawerForm` do. */
  footer?: ReactNode | false | undefined;
  /**
   * The failed mutation, if any. A 422 is shown on the fields it names; what no
   * rendered field can show, and any other failure, is a banner above the form.
   */
  error?: unknown | undefined;
  labelCol?: number | undefined;
  /** The `<form>`'s id, for a submit button outside it (`<Button form={id}>`). */
  id?: string | undefined;
  /**
   * Called when the operator changes a field — not when code sets one. What a
   * page form uses to know it has unsaved work (`useLeaveGuard`).
   */
  onValuesChange?: (() => void) | undefined;
}

/** The visible fields grouped by `section`, or `null` when the form has none. */
function sectionsOf<F extends FieldSpec>(
  fields: readonly F[],
): { title: string; fields: F[] }[] | null {
  if (!fields.some((spec) => spec.section !== undefined)) return null;
  const groups: { title: string; fields: F[] }[] = [];
  for (const spec of fields) {
    const title = spec.section ?? '';
    const group = groups.find((entry) => entry.title === title);
    if (group) group.fields.push(spec);
    else groups.push({ title, fields: [spec] });
  }
  return groups;
}

/**
 * Enter in a one-line field saves the form, but in a date picker it confirms
 * the date someone just typed. The picker leaves the key to the browser, which
 * would submit the form too and save a dialog that is half filled in.
 */
function keepEnterInPickers(event: KeyboardEvent<HTMLFormElement>): void {
  if (event.key !== 'Enter') return;
  if (event.target instanceof Element && event.target.closest('.ant-picker')) {
    event.preventDefault();
  }
}

/**
 * antd `Form` driven by a zod schema.
 *
 * - Per-field validation comes from `schema.shape[name]`, so a field can never
 *   disagree with the contract.
 * - Cross-field rules (`.refine`, `.superRefine`) are enforced on submit by
 *   parsing the whole object and pushing the issues back onto fields.
 * - A server 422 is mapped onto fields from `details`. An error on a row of a
 *   `custom` field shows under that field; one no visible field can show
 *   (`params.id`, a field hidden by `visibleWhen`) is listed in the banner.
 * - `onSubmit` receives `z.output`, i.e. the parsed value ready to send.
 *
 * ```tsx
 * <ZodForm
 *   schema={couponCreate.body}
 *   columns={2}
 *   fields={[
 *     { kind: 'text',  name: 'name',  label: '名称' },
 *     { kind: 'money', name: 'value', label: '面额' },
 *     { kind: 'dateRange', name: 'window', label: '有效期' },
 *   ]}
 *   onSubmit={(values) => save.mutate({ body: values })}
 *   submitting={save.isPending}
 *   error={save.error}
 * />
 * ```
 */
export function ZodForm<S extends AnyObjectSchema>({
  schema,
  fields,
  initialValues,
  onSubmit,
  form: externalForm,
  layout = 'vertical',
  columns = 1,
  disabled = false,
  submitting = false,
  submitText = '保存',
  cancelText = '取消',
  onCancel,
  footer,
  error,
  labelCol,
  id,
  onValuesChange,
}: ZodFormProps<S>) {
  const [internalForm] = Form.useForm();
  const form = externalForm ?? internalForm;

  // Drives `visibleWhen`. `[]` watches the whole value object.
  const watched = Form.useWatch([], form) as Record<string, unknown> | undefined;
  const values = watched ?? (initialValues as Record<string, unknown> | undefined) ?? {};

  const defaultSpan = 24 / columns;

  const visibleFields = fields.filter(
    (spec) => spec.visibleWhen === undefined || spec.visibleWhen(values),
  );
  // A `hidden` field renders `noStyle`, so it cannot show an error.
  const errorFieldNames = visibleFields
    .filter((spec) => spec.kind !== 'hidden')
    .map((spec) => spec.name);

  const serverMatch = useFieldErrors(form, error, errorFieldNames);
  // Whole-form rule failures that no field can show, from the last submit.
  const [clientUnmatched, setClientUnmatched] = useState<string[]>([]);

  const banner = useMemo(() => {
    if (ApiError.is(error) && error.status !== 401) {
      if (!serverMatch) return { message: error.message, details: [] };
      if (serverMatch.unmatched.length > 0) {
        return { message: error.message, details: serverMatch.unmatched };
      }
    }
    if (clientUnmatched.length > 0) return { message: '提交的数据有误', details: clientUnmatched };
    return null;
  }, [error, serverMatch, clientUnmatched]);

  async function handleFinish(raw: unknown): Promise<void> {
    // Cleared fields become "nothing" the contract accepts, text is trimmed.
    const result = schema.safeParse(normaliseFormValues(schema, raw, visibleFields));
    if (!result.success) {
      setClientUnmatched(applyZodIssues(form, result.error, errorFieldNames).unmatched);
      return;
    }
    setClientUnmatched([]);
    await onSubmit(result.data as z.output<S>);
  }

  const renderField = (spec: (typeof visibleFields)[number]): ReactNode => {
    if (spec.kind === 'hidden') {
      return (
        <Form.Item key={String(spec.name)} name={toNamePath(spec.name)} noStyle>
          <input type="hidden" />
        </Form.Item>
      );
    }

    const rule = zodFieldRule(schema, spec.name, spec);
    const valuePropName = valuePropNameOf(spec);
    const span = spec.span ?? defaultSpan;

    return (
      <Col key={String(spec.name)} xs={24} md={span}>
        <Form.Item
          name={toNamePath(spec.name)}
          label={spec.label}
          extra={spec.help}
          tooltip={spec.tooltip}
          required={spec.required ?? isFieldRequired(schema, spec.name)}
          rules={[...(rule ? [rule] : []), ...(spec.rules ?? [])]}
          {...(valuePropName ? { valuePropName } : {})}
        >
          {renderControl(spec, disabled, fieldSchemaOf(schema, spec.name))}
        </Form.Item>
      </Col>
    );
  };

  const sections = sectionsOf(visibleFields);

  return (
    <Form
      form={form}
      layout={layout}
      disabled={disabled}
      {...defined({ id, initialValues: initialValues as Record<string, unknown> | undefined })}
      onFinish={(raw) => handleFinish(raw)}
      onFinishFailed={() => setClientUnmatched([])}
      {...(onValuesChange ? { onValuesChange: () => onValuesChange() } : {})}
      requiredMark
      scrollToFirstError
      // The contract validates, in Chinese, under the field. A browser's own
      // check (a `maxLength` a stored value already exceeds) would block the
      // submit with a bubble in the browser's language instead.
      noValidate
      onKeyDown={keepEnterInPickers}
      {...(layout === 'horizontal' && labelCol ? { labelCol: { flex: `${labelCol}px` } } : {})}
    >
      {banner ? <FormErrorBanner message={banner.message} details={banner.details} /> : null}

      {sections === null ? (
        <Row gutter={16}>{visibleFields.map(renderField)}</Row>
      ) : (
        sections.map((section) => (
          <Card key={section.title} size="small" title={section.title} style={{ marginBottom: 16 }}>
            <Row gutter={16}>{section.fields.map(renderField)}</Row>
          </Card>
        ))
      )}

      {footer === false ? null : (
        <Form.Item style={{ marginBottom: 0, marginTop: 8 }}>
          {/* Where every dialog puts them: on the right, 取消 before 保存. */}
          {footer ?? (
            <Flex justify="flex-end" gap={8}>
              {onCancel ? (
                <Button onClick={onCancel} disabled={submitting}>
                  {cancelText}
                </Button>
              ) : null}
              <Button type="primary" htmlType="submit" loading={submitting}>
                {submitText}
              </Button>
            </Flex>
          )}
        </Form.Item>
      )}
    </Form>
  );
}
