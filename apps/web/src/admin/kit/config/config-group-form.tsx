'use client';

import { ExperimentOutlined } from '@ant-design/icons';
import {
  Anchor,
  App,
  Badge,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import type { RouteInput } from '../../api/call-route';
import type { AnyRouteDef, ResponseOf } from '../../api/contracts';
import { ApiError } from '../../api/errors';
import { useRouteMutation } from '../../api/hooks';
import { AssetField } from '../form/asset-field';
import { MoneyInput } from '../form/money-input';
import { FormErrorBanner, useFieldErrors } from '../form/form-errors';
import { RichTextField } from '../form/rich-text-field';
import { ColorField, UnitNumberInput, UrlInput } from './config-controls';
import { ConfigTestModal, type ConfigTestOutcome } from './config-test-modal';
import {
  buildConfigPayload,
  changedConfigKeys,
  isConfigFieldVisible,
  type ConfigFieldDescriptor,
  type ConfigGroupDescriptor,
  type ConfigValues,
} from './types';
import { useLeaveGuard } from '../leave-guard';
import { defined } from '../props';
import { useSaveShortcut } from '../save-shortcut';

export interface ConfigGroupFormProps<R extends AnyRouteDef, T extends AnyRouteDef = AnyRouteDef> {
  descriptor: ConfigGroupDescriptor;
  /** Current values. `password` keys hold a boolean "is set" flag, not the secret. */
  values: ConfigValues | undefined;
  /** The save route. */
  route: R;
  /**
   * Default `(payload) => ({ params: { group }, body: { values: payload } })`.
   * Keep the payload under `body.values`: a 422 names a field `values.<key>`,
   * and that is how the form finds the field to show it on.
   */
  toInput?: ((payload: ConfigValues) => RouteInput<R>) | undefined;
  invalidate?: readonly AnyRouteDef[] | undefined;
  successMessage?: string | undefined;
  onSuccess?: ((data: ResponseOf<R>) => void) | undefined;
  loading?: boolean | undefined;
  disabled?: boolean | undefined;
  columns?: 1 | 2 | undefined;
  /** Extra content between the description and the fields. */
  header?: ReactNode | undefined;
  /**
   * The 「测试」 route, used when `descriptor.test` is set. Default input
   * `{ params: { group }, body: { values: payload, input } }`.
   */
  testRoute?: T | undefined;
  /** Invalidated after a test run, e.g. the index that shows 「上次测试」. */
  testInvalidate?: readonly AnyRouteDef[] | undefined;
  /**
   * A right-hand column that follows the form as it is edited — a live preview.
   * Receives the values on the screen, saved or not.
   */
  aside?: ((values: ConfigValues) => ReactNode) | undefined;
  /**
   * A field to scroll to and flash once the form has loaded. The settings
   * search links here with `?field=<key>`.
   */
  focusKey?: string | undefined;
}

/**
 * Renders one settings group from a descriptor and saves it through a mutation
 * route. Every settings page in the admin is this component plus a descriptor —
 * the 575-key `sys_config` screen zoo is gone.
 *
 * Layout: fields with no `section` sit in one card, each section in a card of
 * its own, in the order the sections first appear. Three sections or more get
 * a table of contents in the right-hand column, under the `aside` preview.
 *
 * The save bar sticks to the bottom of the window: it counts the fields that
 * differ from what is saved (each one is marked in the form), offers 放弃修改,
 * and answers Ctrl/⌘+S. Leaving the page with changes asks first.
 *
 * Secrets: a `password` field shows 已设置 / 未设置 and an empty box. Leaving it
 * empty keeps the stored credential; typing replaces it. The secret itself is
 * never sent to the browser and never re-sent unchanged.
 *
 * ```tsx
 * <ConfigGroupForm
 *   descriptor={paymentGroup}
 *   values={data?.values}
 *   route={configSave}
 *   invalidate={[configGet]}
 *   successMessage="已保存"
 * />
 * ```
 */
export function ConfigGroupForm<R extends AnyRouteDef, T extends AnyRouteDef = AnyRouteDef>({
  descriptor,
  values,
  route,
  toInput,
  invalidate,
  successMessage = '已保存',
  onSuccess,
  loading = false,
  disabled = false,
  columns = 1,
  header,
  testRoute,
  testInvalidate,
  aside,
  focusKey,
}: ConfigGroupFormProps<R, T>) {
  const [form] = Form.useForm();
  // Typed secrets live outside the form value so they can never be round-tripped.
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const { token } = theme.useToken();

  const watched = Form.useWatch([], form) as ConfigValues | undefined;
  const current = watched ?? values ?? {};

  const mutation = useRouteMutation(route, {
    presentError: false,
    ...(invalidate ? { invalidate } : {}),
    successMessage,
    onSuccess(data) {
      setSecrets({});
      onSuccess?.(data);
    },
  });

  useEffect(() => {
    if (values) form.setFieldsValue(values);
  }, [values, form]);

  const visibleFields = descriptor.fields.filter((field) => isConfigFieldVisible(field, current));
  // A read-only field has no `name`, and a secret lives outside the form, so
  // neither can show an error of its own: theirs go in the banner.
  const errorFieldNames = visibleFields
    .filter((field) => field.readOnly !== true && field.kind !== 'password')
    .map((field) => field.key);
  const serverMatch = useFieldErrors(form, mutation.error, errorFieldNames, { prefix: 'values' });

  const error = mutation.error;
  const banner = !ApiError.is(error)
    ? null
    : !serverMatch
      ? { message: error.message, details: [] }
      : serverMatch.unmatched.length > 0
        ? { message: error.message, details: serverMatch.unmatched }
        : null;

  const changed = disabled ? [] : changedConfigKeys(descriptor, current, values, secrets);
  const dirty = changed.length > 0;
  const changedSet = new Set(changed);

  const defaultSpan = 24 / columns;

  const submit = (raw: ConfigValues): void => {
    const payload = buildConfigPayload(descriptor, raw, secrets);
    const input = toInput
      ? toInput(payload)
      : ({ params: { group: descriptor.group }, body: { values: payload } } as RouteInput<R>);
    mutation.mutate(input);
  };

  const discard = (): void => {
    form.resetFields();
    if (values) form.setFieldsValue(values);
    setSecrets({});
  };

  // Ctrl/⌘+S saves, instead of the browser's "save page as".
  const save = useCallback(() => form.submit(), [form]);
  useSaveShortcut(save, !disabled);

  // Closing the tab, reloading or following a link with unsaved changes asks first.
  useLeaveGuard(dirty);

  // `?field=<key>`: bring the field into view and flash it once. The flash is
  // a Web Animation on the element, not React state: it is over in two seconds
  // and nothing else depends on it.
  const flashColor = token.colorPrimaryBg;
  const { message } = App.useApp();
  useEffect(() => {
    if (loading || focusKey === undefined) return;
    const element = document.getElementById(`config-field-${focusKey}`);
    if (element === null) {
      // Hidden by `visibleWhen`: say which choice brings it up, or the link
      // looks broken.
      const field = descriptor.fields.find((candidate) => candidate.key === focusKey);
      const when = field?.visibleWhen;
      const dependsOn = typeof when === 'object' ? when.key : undefined;
      const dependency = descriptor.fields.find((candidate) => candidate.key === dependsOn);
      if (field && dependency) {
        void message.info(`「${field.label}」要先在「${dependency.label}」里选择对应选项才会显示`);
      }
      return;
    }
    element.scrollIntoView({ block: 'center' });
    element.querySelector<HTMLElement>('input, textarea')?.focus({ preventScroll: true });
    element.firstElementChild?.animate?.(
      [{ backgroundColor: flashColor }, { backgroundColor: 'transparent' }],
      { duration: 2400, easing: 'ease-in' },
    );
  }, [loading, focusKey, flashColor, descriptor.fields, message]);

  // 「测试」
  const [testOpen, setTestOpen] = useState(false);
  const [outcome, setOutcome] = useState<ConfigTestOutcome | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const testMutation = useRouteMutation((testRoute ?? route) as T, {
    presentError: false,
    ...(testInvalidate ? { invalidate: testInvalidate } : {}),
  });
  const runTest = async (input: ConfigValues): Promise<void> => {
    setTestError(null);
    setOutcome(null);
    let raw: ConfigValues;
    try {
      raw = (await form.validateFields()) as ConfigValues;
    } catch {
      setTestError('表单里有未通过校验的项，先改正再测试');
      return;
    }
    const payload = buildConfigPayload(descriptor, raw, secrets);
    testMutation.mutate(
      { params: { group: descriptor.group }, body: { values: payload, input } } as RouteInput<T>,
      {
        onSuccess: (data) => setOutcome(data as ConfigTestOutcome),
        onError: (err) => setTestError(describeTestError(err)),
      },
    );
  };
  const canTest = descriptor.test !== undefined && testRoute !== undefined && !disabled;

  if (loading) {
    return (
      <Card size="small">
        <Skeleton active paragraph={{ rows: 6 }} />
      </Card>
    );
  }

  const runs = groupBySection(visibleFields);
  const named = runs.filter((run) => run.section !== undefined);
  const showToc = named.length >= 3;
  const asideContent = aside ? aside(current) : null;
  const hasAside = asideContent !== null || showToc;

  const renderField = (field: ConfigFieldDescriptor): ReactNode => {
    const isChanged = changedSet.has(field.key);
    const control =
      field.readOnly === true ? (
        <ReadOnlyField field={field} value={values?.[field.key]} />
      ) : field.kind === 'password' ? (
        <SecretField
          field={field}
          isSet={Boolean(values?.[field.key])}
          value={secrets[field.key] ?? ''}
          disabled={disabled}
          onChange={(next) => setSecrets((prev) => ({ ...prev, [field.key]: next }))}
        />
      ) : (
        <Form.Item
          name={field.key}
          label={field.label}
          extra={field.help}
          valuePropName={field.kind === 'switch' ? 'checked' : 'value'}
          rules={
            field.required
              ? [{ required: true, message: `请填写${field.label}` }]
              : field.kind === 'json'
                ? [{ validator: validateJson }]
                : field.kind === 'color'
                  ? [{ validator: validateColor }]
                  : []
          }
        >
          {renderConfigControl(field, disabled)}
        </Form.Item>
      );
    return (
      <Col
        key={field.key}
        id={`config-field-${field.key}`}
        xs={24}
        md={field.kind === 'richtext' ? 24 : (field.span ?? defaultSpan)}
        data-changed={isChanged ? 'true' : undefined}
      >
        <div
          style={{
            borderInlineStart: `3px solid ${isChanged ? token.colorWarning : 'transparent'}`,
            paddingInlineStart: 10,
            marginInlineStart: -13,
            borderRadius: token.borderRadiusSM,
            transition: 'border-color 0.2s',
          }}
        >
          {control}
        </div>
      </Col>
    );
  };

  const formBody = (
    <Form
      form={form}
      layout="vertical"
      disabled={disabled}
      {...defined({ initialValues: values })}
      onFinish={(raw) => submit(raw as ConfigValues)}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {descriptor.description || header || banner ? (
          <div>
            {descriptor.description ? (
              <Typography.Paragraph type="secondary" style={{ marginBottom: header ? 8 : 0 }}>
                {descriptor.description}
              </Typography.Paragraph>
            ) : null}
            {header}
            {banner ? <FormErrorBanner message={banner.message} details={banner.details} /> : null}
          </div>
        ) : null}

        {runs.map(({ section, fields }, index) => (
          <Card
            key={section ?? ''}
            id={sectionId(index)}
            size="small"
            {...(section === undefined ? {} : { title: section })}
            styles={{ body: { paddingBottom: 0 } }}
            style={{ scrollMarginTop: 72 }}
          >
            <Row gutter={16}>{fields.map(renderField)}</Row>
          </Card>
        ))}
      </Space>

      {/* A form that cannot be saved has no save bar: a greyed 保存 reads as
          "not yet", and there is never anything unsaved to report. */}
      {disabled ? null : (
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            zIndex: 5,
            marginTop: 16,
            padding: '12px 16px',
            background: token.colorBgContainer,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusLG,
            boxShadow: dirty ? token.boxShadowSecondary : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span data-testid="config-dirty-state">
            {dirty ? (
              <Badge status="warning" text={`已修改 ${changed.length} 项，尚未保存`} />
            ) : (
              <Badge status="default" text="没有未保存的修改" />
            )}
          </span>
          <Space wrap>
            {canTest ? (
              <Button
                icon={<ExperimentOutlined />}
                onClick={() => {
                  setOutcome(null);
                  setTestError(null);
                  setTestOpen(true);
                }}
              >
                {descriptor.test!.label}
              </Button>
            ) : null}
            <Button disabled={!dirty || disabled} onClick={discard}>
              放弃修改
            </Button>
            <Tooltip title="Ctrl / ⌘ + S">
              <Button type="primary" htmlType="submit" loading={mutation.isPending}>
                保存
              </Button>
            </Tooltip>
          </Space>
        </div>
      )}
    </Form>
  );

  return (
    <>
      {hasAside ? (
        <Row gutter={16} wrap>
          <Col xs={24} xl={asideContent !== null ? 15 : 19}>
            {formBody}
          </Col>
          <Col xs={24} xl={asideContent !== null ? 9 : 5}>
            <div style={{ position: 'sticky', top: 72 }}>
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                {asideContent}
                {showToc ? (
                  <Card size="small" title="目录">
                    <Anchor
                      offsetTop={72}
                      affix={false}
                      items={runs.flatMap((run, index) =>
                        run.section === undefined
                          ? []
                          : [
                              {
                                key: sectionId(index),
                                href: `#${sectionId(index)}`,
                                title: run.section,
                              },
                            ],
                      )}
                    />
                  </Card>
                ) : null}
              </Space>
            </div>
          </Col>
        </Row>
      ) : (
        formBody
      )}

      {canTest ? (
        <ConfigTestModal
          open={testOpen}
          onClose={() => setTestOpen(false)}
          test={descriptor.test!}
          dirty={dirty}
          running={testMutation.isPending}
          outcome={outcome}
          error={testError}
          onRun={(input) => runTest(input)}
          renderControl={(field) => renderConfigControl(field, false)}
        />
      ) : null}
    </>
  );
}

const sectionId = (index: number): string => `config-section-${index}`;

function describeTestError(error: unknown): string {
  if (!ApiError.is(error)) return '测试请求失败，请稍后再试';
  if (Array.isArray(error.details)) {
    const messages = error.details
      .map((item) => (item as { message?: unknown }).message)
      .filter((message): message is string => typeof message === 'string');
    if (messages.length > 0) return `${error.message}：${messages.join('；')}`;
  }
  return error.message;
}

/**
 * Runs of fields sharing a `section`, in first-appearance order.
 *
 * A descriptor where no field has a section yields exactly one run with no
 * heading, which renders the same single `<Row>` the form has always rendered.
 *
 * Deliberately not `<Tabs>`: a settings form saves as one payload, and a
 * validation error on a hidden tab is invisible.
 */
function groupBySection(
  fields: readonly ConfigFieldDescriptor[],
): { section: string | undefined; fields: ConfigFieldDescriptor[] }[] {
  const runs: { section: string | undefined; fields: ConfigFieldDescriptor[] }[] = [];
  const bySection = new Map<string | undefined, ConfigFieldDescriptor[]>();
  for (const field of fields) {
    let bucket = bySection.get(field.section);
    if (!bucket) {
      bucket = [];
      bySection.set(field.section, bucket);
      runs.push({ section: field.section, fields: bucket });
    }
    bucket.push(field);
  }
  return runs;
}

/**
 * A deployment fact, shown and not edited.
 *
 * No `name`, deliberately: the field never joins the form's values, so it
 * cannot be submitted even by a `buildConfigPayload` that forgot to skip it,
 * and a 422 naming it has no field to land on, so it shows in the banner. A
 * disabled `<Input>` would have been fewer lines and the wrong shape — it reads
 * as "you may not do this *yet*", and antd still carries a disabled field's
 * value in the payload.
 *
 * `help` carries the source (`由部署环境决定：env:PUBLIC_ORIGIN`), which the
 * server folded in, so the screen answers "then where do I change it".
 */
function ReadOnlyField({ field, value }: { field: ConfigFieldDescriptor; value: unknown }) {
  return (
    <Form.Item label={field.label} extra={field.help}>
      <Typography.Text
        {...(value === undefined || value === null || value === ''
          ? ({ type: 'secondary' } as const)
          : {})}
        data-testid={`readonly-value-${field.key}`}
        style={{ wordBreak: 'break-all' }}
      >
        {readOnlyText(value)}
      </Typography.Text>
    </Form.Item>
  );
}

function readOnlyText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '未设置';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length === 0 ? '未设置' : value.join('、');
  return String(value);
}

function SecretField({
  field,
  isSet,
  value,
  disabled,
  onChange,
}: {
  field: ConfigFieldDescriptor;
  isSet: boolean;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Form.Item
      label={
        <span>
          {field.label}{' '}
          <Tag
            color={isSet ? 'success' : 'default'}
            bordered={false}
            data-testid={`secret-state-${field.key}`}
          >
            {isSet ? '已设置' : '未设置'}
          </Tag>
        </span>
      }
      extra={field.help ?? '留空表示不修改已保存的值'}
    >
      <Input.Password
        value={value}
        disabled={disabled}
        autoComplete="new-password"
        placeholder={isSet ? '已设置，留空则不修改' : (field.placeholder ?? '请输入')}
        data-testid={`secret-input-${field.key}`}
        onChange={(event) => onChange(event.target.value)}
      />
    </Form.Item>
  );
}

async function validateJson(_rule: unknown, value: unknown): Promise<void> {
  if (value === undefined || value === null || value === '') return;
  try {
    JSON.parse(String(value));
  } catch {
    throw new Error('不是合法的 JSON');
  }
}

async function validateColor(_rule: unknown, value: unknown): Promise<void> {
  if (value === undefined || value === null || value === '') return;
  if (!/^#[0-9a-fA-F]{6}$/.test(String(value))) throw new Error('颜色格式应为 #RRGGBB');
}

function renderConfigControl(field: ConfigFieldDescriptor, disabled: boolean): ReactNode {
  switch (field.kind) {
    case 'color':
      // Clearable when the placeholder says what blank means (「留空则与主题色相同」);
      // a placeholder that is itself a colour is just the default, and blank is refused.
      return (
        <ColorField
          disabled={disabled}
          allowClear={field.placeholder !== undefined && !field.placeholder.startsWith('#')}
          {...defined({ placeholder: field.placeholder })}
        />
      );
    case 'richtext':
      return <RichTextField />;
    case 'url':
      return <UrlInput disabled={disabled} {...defined({ placeholder: field.placeholder })} />;
    case 'text':
      return <Input placeholder={field.placeholder} disabled={disabled} allowClear />;
    case 'textarea':
      return <Input.TextArea rows={4} placeholder={field.placeholder} disabled={disabled} />;
    case 'json':
      return (
        <Input.TextArea
          rows={6}
          placeholder={field.placeholder ?? '{ }'}
          disabled={disabled}
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
        />
      );
    case 'number':
      if (field.unit) {
        return (
          <UnitNumberInput
            unit={field.unit}
            disabled={disabled}
            {...defined({ min: field.min, placeholder: field.placeholder })}
          />
        );
      }
      return (
        <InputNumber
          style={{ width: '100%' }}
          {...defined({ min: field.min, placeholder: field.placeholder })}
          disabled={disabled}
        />
      );
    case 'money':
      return <MoneyInput {...defined({ placeholder: field.placeholder })} disabled={disabled} />;
    case 'switch':
      return <Switch disabled={disabled} />;
    case 'select':
      return (
        <Select
          options={(field.options ?? []) as never}
          placeholder={field.placeholder ?? '请选择'}
          disabled={disabled}
          allowClear
        />
      );
    case 'asset':
      return (
        <AssetField
          multiple={field.multiple ?? false}
          {...defined({ max: field.max })}
          valueType="url"
          disabled={disabled}
        />
      );
    default:
      return <Input disabled={disabled} />;
  }
}
