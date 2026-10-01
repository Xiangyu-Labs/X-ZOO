'use client';

import { Button, Form, Input, InputNumber, Space, Switch, Typography } from 'antd';
import { useState } from 'react';
import type {
  PresaleActivityForm,
  PresaleActivityStatus,
  PresaleOrderStage,
  PresalePaymentMode,
} from '@shop/contracts/presale/schemas';

import { MoneyInput } from '@/admin/kit/form/money-input';
import { ProductSelect } from '@/admin/kit/product-select';
import { SkuPicker } from '@/admin/kit/sku-picker';
import type { FieldSpec } from '@/admin/kit/form/types';
import type { StatusMap } from '@/admin/kit/status-tag';

/**
 * The presale domain's enums and form fields, in one file next to the pages.
 *
 * One `StatusMap` per enum, shared by the table column, the filter bar and the
 * form, so a label can never say 进行中 in one place and 已启用 in another. The
 * keys are the contract's own union members, so deleting a value from the
 * contract is a compile error here rather than a blank tag in production.
 */

export const PRESALE_ACTIVITY_STATUS: StatusMap<PresaleActivityStatus> = {
  draft: { label: '草稿', color: 'default' },
  active: { label: '进行中', color: 'success' },
  paused: { label: '已暂停', color: 'warning' },
  ended: { label: '已结束', color: 'default' },
};

export const PRESALE_PAYMENT_MODE: StatusMap<PresalePaymentMode> = {
  full: { label: '全款预售', color: 'blue' },
  // Present because migrated data can carry it and the admin must not render a
  // blank tag; no route ever creates one (`PRESALE_DEPOSIT_NOT_SUPPORTED`).
  deposit: { label: '定金预售（不支持）', color: 'error' },
};

/**
 * The stage machine of `presale_orders`.
 *
 * Four of the six are unreachable in a full-payment shop and say so, because an
 * operator looking at historical orders will see them and the honest answer is
 * "this is a historical order", not a blank cell.
 */
export const PRESALE_ORDER_STAGE: StatusMap<PresaleOrderStage> = {
  deposit_pending: { label: '待付定金（历史）', color: 'default' },
  deposit_paid: { label: '已付定金（历史）', color: 'default' },
  final_pending: { label: '待付款', color: 'processing' },
  final_paid: { label: '已付款', color: 'success' },
  expired: { label: '已过期', color: 'default' },
  cancelled: { label: '已取消/已退款', color: 'error' },
};

const options = <K extends string>(map: StatusMap<K>) =>
  (Object.keys(map) as K[]).map((value) => ({ label: map[value].label, value }));

/** One row of the 规格 editor. Kept loose because the form value is JSON. */
interface SkuRow {
  skuId: string;
  price: string;
  stock: number;
  quota?: number | undefined;
  isEnabled: boolean;
}

/**
 * The 规格 cell: the kit's picker, with the typed-in id as the fallback.
 *
 * Until A2 the id was pasted from the product page, which let an operator name
 * a real SKU of the *wrong* product. The server refuses it
 * (`PRESALE_SKU_NOT_IN_ACTIVITY`) but only after the whole form is filled in;
 * 选择 opens `<SkuPicker>` scoped to the activity's own 商品 ID, so the wrong
 * product is never on offer.
 *
 * The id stays editable because a migrated activity can name a SKU whose
 * product has since left the shelf, and the picker lists on-shelf products.
 */
function SkuIdField({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (skuId: string) => void;
}) {
  const form = Form.useFormInstance();
  const productId = Form.useWatch<string | undefined>('productId', form);
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Text, not a number box: an id is a string on the wire, and has no 上下箭头 to step. */}
      <Input
        style={{ width: 160 }}
        value={value}
        placeholder="规格 ID"
        inputMode="numeric"
        disabled={disabled}
        prefix="SKU"
        onChange={(event) => onChange(event.target.value.replace(/\D/g, ''))}
      />
      <Button
        size="small"
        disabled={disabled || productId === undefined || productId === ''}
        onClick={() => setOpen(true)}
      >
        选择
      </Button>
      <SkuPicker
        open={open}
        multiple={false}
        productId={productId === '' ? undefined : productId}
        onClose={() => setOpen(false)}
        onSelect={(picked) => {
          const first = picked[0];
          if (first !== undefined) onChange(first.skuId);
        }}
      />
    </>
  );
}

/**
 * The create/edit form.
 *
 * Every rule comes from `presaleAdminActivityCreate.body` — required markers,
 * ranges, `endAt > startAt`, the duplicate-SKU check and the refusal of
 * `paymentMode: 'deposit'` — so this list only says how each field is *typed
 * in*.
 *
 * `paymentMode` is deliberately absent: the contract defaults it to `full` and
 * the service overwrites it anyway. A disabled radio group offering a choice
 * that is always refused would be a worse lie than not offering it.
 *
 * The 规格 rows are a `sortableList`, each with the kit's `<SkuPicker>` behind
 * a 选择 button. The server still checks every id really belongs to the
 * product (`PRESALE_SKU_NOT_IN_ACTIVITY`), so a hand-typed id is a 422 rather
 * than a mispriced sale — the picker is what stops the operator reaching that
 * 422 in the first place.
 */
export const presaleFields: FieldSpec<Extract<keyof PresaleActivityForm, string>>[] = [
  // Ids cross the wire as decimal strings (CONVENTIONS); the picker hands back the string.
  {
    kind: 'custom',
    name: 'productId',
    label: '商品',
    span: 12,
    help: '选好后用下面每行的「选择」挑规格',
    render: ({ value, onChange, disabled, id }) => (
      <ProductSelect
        id={id}
        value={typeof value === 'string' ? value : undefined}
        onChange={onChange}
        disabled={disabled}
      />
    ),
  },
  { kind: 'text', name: 'title', label: '活动标题', span: 12, placeholder: '春茶预售 · 明前龙井' },
  {
    kind: 'select',
    name: 'status',
    label: '状态',
    span: 6,
    options: options(PRESALE_ACTIVITY_STATUS).filter((option) => option.value !== 'ended'),
    help: '草稿不会出现在前台；已结束由定时任务写入',
  },

  { kind: 'text', name: 'intro', label: '简介', span: 18, maxLength: 255 },
  { kind: 'asset', name: 'imageUrl', label: '主图', span: 12 },
  { kind: 'asset', name: 'sliderImages', label: '轮播图', span: 24, multiple: true, max: 10 },

  { kind: 'money', name: 'price', label: '预售价', span: 6 },
  { kind: 'money', name: 'originalPrice', label: '原价', span: 6, help: '划线价，留空不展示' },
  { kind: 'number', name: 'stock', label: '活动库存', span: 6, min: 0 },
  // What the form loaded with; the server keeps an untouched stock and refuses
  // a changed one that orders moved meanwhile.
  { kind: 'hidden', name: 'expectedStock' },
  {
    kind: 'number',
    name: 'totalQuota',
    label: '限购总量',
    span: 6,
    min: 0,
    help: '整个活动最多卖出多少件，留空不限',
  },

  { kind: 'date', name: 'startAt', label: '开始时间', span: 6, showTime: true },
  { kind: 'date', name: 'endAt', label: '结束时间', span: 6, showTime: true },
  {
    kind: 'number',
    name: 'perOrderQuantity',
    label: '每单限购',
    span: 6,
    min: 1,
    max: 999,
    help: '一张预售订单最多几件',
  },
  {
    kind: 'number',
    name: 'shipAfterDays',
    label: '付款后发货天数',
    span: 6,
    min: 0,
    max: 365,
    addonAfter: '天',
    help: '承诺在付款后第几天内发货；改动不影响已付款的订单',
  },

  {
    kind: 'text',
    name: 'shippingTemplateId',
    label: '运费模板 ID',
    span: 6,
    help: '留空沿用商品自身的运费设置',
  },
  { kind: 'number', name: 'sortOrder', label: '排序', span: 6, min: 0, max: 9999 },

  {
    kind: 'sortableList',
    name: 'skus',
    label: '参与预售的规格',
    span: 24,
    addText: '添加规格',
    emptyText: '尚未配置规格，前台将无法下单',
    newItem: () => ({ skuId: '', price: '', stock: 0, isEnabled: true }),
    renderItem: (item: never, helpers) => {
      const sku = item as unknown as SkuRow;
      const patch = (next: Partial<SkuRow>) => helpers.set({ ...sku, ...next } as unknown as never);
      return (
        <Space wrap>
          <SkuIdField
            value={sku.skuId}
            disabled={helpers.disabled}
            onChange={(skuId) => patch({ skuId })}
          />
          <Space size={4}>
            <Typography.Text type="secondary">预售价</Typography.Text>
            {/* The kit's money control: a string of yuan end to end, never a float. */}
            <MoneyInput
              value={sku.price}
              placeholder="预售价"
              disabled={helpers.disabled}
              onChange={(value) => patch({ price: value ?? '' })}
            />
          </Space>
          <InputNumber
            value={sku.stock}
            min={0}
            placeholder="库存"
            disabled={helpers.disabled}
            addonBefore="库存"
            onChange={(value) => patch({ stock: value ?? 0 })}
          />
          <InputNumber
            value={sku.quota ?? null}
            min={0}
            placeholder="不限"
            disabled={helpers.disabled}
            addonBefore="限购"
            onChange={(value) => patch({ quota: value ?? undefined })}
          />
          <Space size={4}>
            <Switch
              checked={sku.isEnabled}
              disabled={helpers.disabled}
              onChange={(checked) => patch({ isEnabled: checked })}
            />
            <Typography.Text type="secondary">可售</Typography.Text>
          </Space>
        </Space>
      );
    },
  },
];
