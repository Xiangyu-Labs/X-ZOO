'use client';

import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Typography,
  message,
} from 'antd';
import { useState } from 'react';
import { catalogAdminSkuMatrix } from '@shop/contracts/catalog/catalog.product.admin.contract';
import type {
  ProductKind,
  ProductParam,
  ProductSkuInput,
  ProductSpecInput,
} from '@shop/contracts/catalog/schemas';

import { useRouteMutation } from '@/admin/api/hooks';
import { MoneyInput } from '@/admin/kit/form/money-input';

/**
 * The spec matrix half of the product editor.
 *
 * Three controls that live inside the one `ZodForm`, each an antd
 * `value`/`onChange` control so the form owns the data and the contract owns
 * the validation:
 *
 *  - `SpecEditor`   — the axes (颜色, 尺码) and their values
 *  - `SkuMatrixEditor` — one row per combination, with the prices and stock
 *  - `ParamEditor`  — the 商品参数 name/value pairs
 *
 * The combinations themselves are computed *server-side* (`/sku-matrix`), not
 * here: the cartesian product is part of what a SKU means, and two
 * implementations of it would eventually disagree about ordering and about
 * what `颜色=红` with a trailing space is.
 */

const EMPTY_SPECS: ProductSpecInput[] = [];
const EMPTY_SKUS: ProductSkuInput[] = [];

/** `{颜色:红, 尺码:XL}` → `红|XL`, in axis order. The SKU's identity. */
export function specTextOf(specValues: Record<string, string>, axes: readonly string[]): string {
  return axes.map((axis) => specValues[axis] ?? '').join('|');
}

/** Order-independent key, for matching a generated row to an existing SKU. */
function comboKey(specValues: Record<string, string>): string {
  return Object.keys(specValues)
    .sort()
    .map((key) => `${key}=${specValues[key]}`)
    .join('|');
}

export function blankSku(specValues: Record<string, string> = {}): ProductSkuInput {
  return {
    specValues,
    price: '0.00',
    stock: 0,
    isDefault: false,
    isVisible: true,
    sortOrder: 0,
  };
}

// ---------------------------------------------------------------------------
// specs
// ---------------------------------------------------------------------------

export interface SpecEditorProps {
  value?: ProductSpecInput[] | undefined;
  onChange?: ((value: ProductSpecInput[]) => void) | undefined;
  disabled?: boolean | undefined;
}

/**
 * The spec axes.
 *
 * Values are a tag input rather than a row of inputs: an operator types 红 红
 * 蓝 and the duplicate is swallowed by the control instead of coming back as a
 * 422. A value's own picture (`imageUrl`) is preserved across edits but not
 * editable here — the picture buyers actually see is the one on the SKU row
 * below, and two places to set it is how a red shirt ends up showing a blue
 * thumbnail.
 */
export function SpecEditor({ value, onChange, disabled = false }: SpecEditorProps) {
  const specs = value ?? EMPTY_SPECS;

  const patch = (index: number, next: ProductSpecInput): void => {
    onChange?.(specs.map((spec, i) => (i === index ? next : spec)));
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      {specs.map((spec, index) => (
        <Card key={index} size="small" styles={{ body: { padding: 12 } }}>
          <Space align="start" style={{ width: '100%' }} size={8}>
            <Input
              style={{ width: 160 }}
              value={spec.name}
              disabled={disabled}
              maxLength={64}
              placeholder="规格名，如 颜色"
              aria-label={`规格名 ${index + 1}`}
              onChange={(event) => patch(index, { ...spec, name: event.target.value })}
            />
            <Select
              style={{ minWidth: 360 }}
              mode="tags"
              disabled={disabled}
              value={spec.values.map((item) => item.value)}
              placeholder="规格值，回车确认"
              aria-label={`规格值 ${index + 1}`}
              open={false}
              suffixIcon={null}
              onChange={(next: string[]) =>
                patch(index, {
                  ...spec,
                  // Keep each value's picture when the value itself survives.
                  values: next.slice(0, 50).map((item) => {
                    const previous = spec.values.find((existing) => existing.value === item);
                    return previous ?? { value: item };
                  }),
                })
              }
            />
            <Button
              type="text"
              danger
              disabled={disabled}
              icon={<DeleteOutlined />}
              aria-label={`删除规格 ${index + 1}`}
              onClick={() => onChange?.(specs.filter((_, i) => i !== index))}
            />
          </Space>
        </Card>
      ))}

      <Button
        type="dashed"
        icon={<PlusOutlined />}
        disabled={disabled || specs.length >= 5}
        onClick={() => onChange?.([...specs, { name: '', values: [] }])}
      >
        添加规格项
      </Button>
    </Space>
  );
}

// ---------------------------------------------------------------------------
// SKU matrix
// ---------------------------------------------------------------------------

export interface SkuMatrixEditorProps {
  value?: ProductSkuInput[] | undefined;
  onChange?: ((value: ProductSkuInput[]) => void) | undefined;
  specs: readonly ProductSpecInput[];
  specMode: boolean;
  kind: ProductKind;
  disabled?: boolean | undefined;
  /** `false` for a role the server hides 成本价 from: no column rather than an empty one. */
  showCost?: boolean | undefined;
}

export function SkuMatrixEditor({
  value,
  onChange,
  specs,
  specMode,
  kind,
  disabled = false,
  showCost = true,
}: SkuMatrixEditorProps) {
  const rows = value ?? EMPTY_SKUS;
  const axes = specs.map((spec) => spec.name).filter(Boolean);
  const cardStock = kind === 'virtual_card';

  const [fillPrice, setFillPrice] = useState<string | undefined>(undefined);
  const [fillStock, setFillStock] = useState<number | null>(null);

  const generate = useRouteMutation(catalogAdminSkuMatrix, { presentError: true });

  const patch = (index: number, changes: Partial<ProductSkuInput>): void => {
    onChange?.(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)));
  };

  /**
   * Regenerate the combinations, carrying every existing row's numbers across
   * by its spec combination. Adding 蓝 to 颜色 must not reset the price of 红.
   */
  const regenerate = (): void => {
    if (axes.length === 0 || specs.some((spec) => spec.values.length === 0)) {
      void message.warning('请先填写完整的规格项和规格值');
      return;
    }
    generate.mutate(
      { body: { specs: specs.map((spec) => ({ name: spec.name, values: spec.values })) } },
      {
        onSuccess: (result) => {
          const existing = new Map(rows.map((row) => [comboKey(row.specValues), row]));
          const next = result.rows.map((row, index) => {
            const previous = existing.get(comboKey(row.specValues));
            return previous
              ? { ...previous, specValues: row.specValues }
              : { ...blankSku(row.specValues), sortOrder: index };
          });
          if (!next.some((row) => row.isDefault) && next[0])
            next[0] = { ...next[0], isDefault: true };
          onChange?.(next);
          void message.success(`已生成 ${next.length} 条规格`);
        },
      },
    );
  };

  const applyFill = (): void => {
    if (fillPrice === undefined && fillStock === null) return;
    onChange?.(
      rows.map((row) => ({
        ...row,
        ...(fillPrice !== undefined ? { price: fillPrice } : {}),
        ...(fillStock !== null && !cardStock ? { stock: fillStock } : {}),
      })),
    );
  };

  if (!specMode) {
    const row = rows[0] ?? blankSku();
    return (
      <Card size="small" styles={{ body: { padding: 12 } }}>
        <SingleSkuFields
          row={row}
          disabled={disabled}
          cardStock={cardStock}
          showCost={showCost}
          onChange={(changes) =>
            onChange?.([{ ...row, ...changes, specValues: {}, isDefault: true }])
          }
        />
      </Card>
    );
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      <Space wrap>
        <Button onClick={regenerate} loading={generate.isPending} disabled={disabled}>
          生成规格组合
        </Button>
        <Typography.Text type="secondary">批量填充：</Typography.Text>
        <MoneyInput
          value={fillPrice}
          onChange={setFillPrice}
          placeholder="售价"
          size="small"
          style={{ width: 120 }}
        />
        {cardStock ? null : (
          <InputNumber
            value={fillStock}
            onChange={setFillStock}
            placeholder="库存"
            size="small"
            min={0}
            aria-label="批量库存"
          />
        )}
        <Button size="small" onClick={applyFill} disabled={disabled}>
          应用
        </Button>
      </Space>

      {cardStock ? (
        <Alert
          type="info"
          showIcon
          message="卡密商品的库存等于已导入卡密的数量，保存时不会写入这里填的数字。"
        />
      ) : null}

      <Table<ProductSkuInput>
        size="small"
        rowKey={(row) => specTextOf(row.specValues, axes) || 'single'}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 1200 }}
        locale={{ emptyText: '还没有规格组合，点「生成规格组合」' }}
        columns={[
          ...axes.map((axis) => ({
            title: axis,
            key: `axis:${axis}`,
            width: 100,
            render: (_value: unknown, row: ProductSkuInput) => row.specValues[axis] ?? '—',
          })),
          {
            title: '图片',
            key: 'imageUrl',
            width: 160,
            render: (_value: unknown, row: ProductSkuInput, index: number) => (
              <Input
                size="small"
                value={row.imageUrl ?? ''}
                disabled={disabled}
                placeholder="图片地址"
                aria-label={`规格图片 ${index + 1}`}
                onChange={(event) => patch(index, { imageUrl: event.target.value || undefined })}
              />
            ),
          },
          {
            title: '售价',
            key: 'price',
            width: 120,
            render: (_value: unknown, row: ProductSkuInput, index: number) => (
              <MoneyInput
                size="small"
                value={row.price}
                disabled={disabled}
                onChange={(next) => patch(index, { price: next ?? '0.00' })}
              />
            ),
          },
          {
            title: '原价',
            key: 'originalPrice',
            width: 120,
            render: (_value: unknown, row: ProductSkuInput, index: number) => (
              <MoneyInput
                size="small"
                value={row.originalPrice}
                disabled={disabled}
                onChange={(next) => patch(index, { originalPrice: next })}
              />
            ),
          },
          ...(showCost
            ? [
                {
                  title: '成本价',
                  key: 'cost',
                  width: 120,
                  render: (_value: unknown, row: ProductSkuInput, index: number) => (
                    <MoneyInput
                      size="small"
                      value={row.cost}
                      disabled={disabled}
                      onChange={(next) => patch(index, { cost: next })}
                    />
                  ),
                },
              ]
            : []),
          {
            title: '库存',
            key: 'stock',
            width: 100,
            render: (_value: unknown, row: ProductSkuInput, index: number) => (
              <InputNumber
                size="small"
                min={0}
                value={row.stock}
                disabled={disabled || cardStock}
                aria-label={`库存 ${index + 1}`}
                onChange={(next) => patch(index, { stock: next ?? 0 })}
              />
            ),
          },
          {
            title: '规格编码',
            key: 'skuCode',
            width: 140,
            render: (_value: unknown, row: ProductSkuInput, index: number) => (
              <Input
                size="small"
                value={row.skuCode ?? ''}
                // A saved SKU keeps its code (orders and exports refer to it);
                // only a new combination takes one.
                disabled={disabled || isSavedSku(row)}
                title={isSavedSku(row) ? SAVED_CODE_HINT : undefined}
                placeholder="留空自动生成"
                aria-label={`规格编码 ${index + 1}`}
                onChange={(event) => patch(index, { skuCode: event.target.value || undefined })}
              />
            ),
          },
          {
            title: '条码',
            key: 'barCode',
            width: 140,
            render: (_value: unknown, row: ProductSkuInput, index: number) => (
              <Input
                size="small"
                value={row.barCode ?? ''}
                disabled={disabled}
                aria-label={`条码 ${index + 1}`}
                onChange={(event) => patch(index, { barCode: event.target.value || undefined })}
              />
            ),
          },
          {
            title: '重量(kg)',
            key: 'weight',
            width: 110,
            render: (_value: unknown, row: ProductSkuInput, index: number) => (
              <Input
                size="small"
                value={row.weight ?? ''}
                disabled={disabled}
                inputMode="decimal"
                aria-label={`重量 ${index + 1}`}
                onChange={(event) => patch(index, { weight: event.target.value || undefined })}
              />
            ),
          },
          {
            title: '体积(m³)',
            key: 'volume',
            width: 110,
            render: (_value: unknown, row: ProductSkuInput, index: number) => (
              <Input
                size="small"
                value={row.volume ?? ''}
                disabled={disabled}
                inputMode="decimal"
                aria-label={`体积 ${index + 1}`}
                onChange={(event) => patch(index, { volume: event.target.value || undefined })}
              />
            ),
          },
          {
            title: '默认',
            key: 'isDefault',
            width: 70,
            render: (_value: unknown, row: ProductSkuInput, index: number) => (
              <Checkbox
                checked={row.isDefault}
                disabled={disabled}
                aria-label={`默认规格 ${index + 1}`}
                // Exactly one default, enforced here rather than left to the
                // contract's 422: clicking a second one moves it.
                onChange={(event) =>
                  onChange?.(
                    rows.map((item, i) => ({
                      ...item,
                      isDefault: event.target.checked && i === index,
                    })),
                  )
                }
              />
            ),
          },
          {
            title: '显示',
            key: 'isVisible',
            width: 70,
            render: (_value: unknown, row: ProductSkuInput, index: number) => (
              <Checkbox
                checked={row.isVisible}
                disabled={disabled}
                aria-label={`显示规格 ${index + 1}`}
                onChange={(event) => patch(index, { isVisible: event.target.checked })}
              />
            ),
          },
        ]}
      />
    </Space>
  );
}

function SingleSkuFields({
  row,
  onChange,
  disabled,
  cardStock,
  showCost,
}: {
  row: ProductSkuInput;
  onChange: (changes: Partial<ProductSkuInput>) => void;
  disabled: boolean;
  cardStock: boolean;
  showCost: boolean;
}) {
  return (
    <Space wrap size={12}>
      <Field label="售价">
        <MoneyInput
          value={row.price}
          disabled={disabled}
          style={{ width: 120 }}
          onChange={(next) => onChange({ price: next ?? '0.00' })}
        />
      </Field>
      <Field label="原价">
        <MoneyInput
          value={row.originalPrice}
          disabled={disabled}
          style={{ width: 120 }}
          onChange={(next) => onChange({ originalPrice: next })}
        />
      </Field>
      {showCost ? (
        <Field label="成本价">
          <MoneyInput
            value={row.cost}
            disabled={disabled}
            style={{ width: 120 }}
            onChange={(next) => onChange({ cost: next })}
          />
        </Field>
      ) : null}
      <Field label="库存">
        <InputNumber
          min={0}
          value={row.stock}
          disabled={disabled || cardStock}
          aria-label="库存"
          onChange={(next) => onChange({ stock: next ?? 0 })}
        />
      </Field>
      <Field label="规格编码">
        <Input
          value={row.skuCode ?? ''}
          disabled={disabled || isSavedSku(row)}
          title={isSavedSku(row) ? SAVED_CODE_HINT : undefined}
          style={{ width: 160 }}
          placeholder="留空自动生成"
          aria-label="规格编码"
          onChange={(event) => onChange({ skuCode: event.target.value || undefined })}
        />
      </Field>
      <Field label="条码">
        <Input
          value={row.barCode ?? ''}
          disabled={disabled}
          style={{ width: 160 }}
          aria-label="条码"
          onChange={(event) => onChange({ barCode: event.target.value || undefined })}
        />
      </Field>
      <Field label="重量(kg)">
        <Input
          value={row.weight ?? ''}
          disabled={disabled}
          style={{ width: 100 }}
          inputMode="decimal"
          aria-label="重量"
          onChange={(event) => onChange({ weight: event.target.value || undefined })}
        />
      </Field>
      <Field label="体积(m³)">
        <Input
          value={row.volume ?? ''}
          disabled={disabled}
          style={{ width: 100 }}
          inputMode="decimal"
          aria-label="体积"
          onChange={(event) => onChange({ volume: event.target.value || undefined })}
        />
      </Field>
    </Space>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Space direction="vertical" size={2}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      {children}
    </Space>
  );
}

// ---------------------------------------------------------------------------
// params
// ---------------------------------------------------------------------------

export interface ParamEditorProps {
  value?: ProductParam[] | undefined;
  onChange?: ((value: ProductParam[]) => void) | undefined;
  /** 参数模板, for the one-click add. */
  templates: readonly { id: string; name: string; suggestedValues: string | null }[];
  disabled?: boolean | undefined;
}

/**
 * 商品参数.
 *
 * A template only *seeds* a row: name and value are copied onto the product, so
 * renaming the template next month does not silently rewrite the spec sheet of
 * every product that ever used it. `templateId` is kept for reporting only.
 */
export function ParamEditor({ value, onChange, templates, disabled = false }: ParamEditorProps) {
  const rows = value ?? [];

  const patch = (index: number, changes: Partial<ProductParam>): void => {
    onChange?.(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)));
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      {rows.map((row, index) => {
        const template = templates.find((item) => item.id === row.templateId);
        const suggestions = (template?.suggestedValues ?? '')
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean);
        return (
          <Space key={index} align="start" size={8}>
            <Input
              style={{ width: 160 }}
              value={row.name}
              disabled={disabled}
              maxLength={64}
              placeholder="参数名"
              aria-label={`参数名 ${index + 1}`}
              onChange={(event) => patch(index, { name: event.target.value })}
            />
            {suggestions.length > 0 ? (
              <Select
                style={{ width: 320 }}
                mode="tags"
                maxCount={1}
                disabled={disabled}
                value={row.value ? [row.value] : []}
                options={suggestions.map((item) => ({ label: item, value: item }))}
                placeholder="参数值"
                aria-label={`参数值 ${index + 1}`}
                onChange={(next: string[]) => patch(index, { value: next[0] ?? '' })}
              />
            ) : (
              <Input
                style={{ width: 320 }}
                value={row.value}
                disabled={disabled}
                maxLength={255}
                placeholder="参数值"
                aria-label={`参数值 ${index + 1}`}
                onChange={(event) => patch(index, { value: event.target.value })}
              />
            )}
            <Button
              type="text"
              danger
              disabled={disabled}
              icon={<DeleteOutlined />}
              aria-label={`删除参数 ${index + 1}`}
              onClick={() => onChange?.(rows.filter((_, i) => i !== index))}
            />
          </Space>
        );
      })}

      <Space wrap>
        <Button
          type="dashed"
          icon={<PlusOutlined />}
          disabled={disabled || rows.length >= 50}
          onClick={() =>
            onChange?.([...rows, { name: '', value: '', templateId: null, sortOrder: rows.length }])
          }
        >
          添加参数
        </Button>
        <Select
          style={{ width: 220 }}
          disabled={disabled || templates.length === 0}
          value={null}
          placeholder="从参数模板添加"
          options={templates.map((item) => ({ label: item.name, value: item.id }))}
          onChange={(templateId: string) => {
            const template = templates.find((item) => item.id === templateId);
            if (!template) return;
            onChange?.([
              ...rows,
              { name: template.name, value: '', templateId, sortOrder: rows.length },
            ]);
          }}
        />
      </Space>
    </Space>
  );
}

const SAVED_CODE_HINT = '已保存的规格编码不能修改';

/**
 * A row that came from the server: `formValuesOf` gives it the stock the
 * operator is looking at. The server matches rows by spec combination and
 * never rewrites a saved SKU's code, so an editable box would be ignored.
 */
function isSavedSku(row: ProductSkuInput): boolean {
  return row.expectedStock !== undefined;
}
