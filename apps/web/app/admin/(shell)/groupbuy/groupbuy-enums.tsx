'use client';

import { Button, Form, Input, InputNumber, Space, Switch, Typography } from 'antd';
import { useState } from 'react';
import type {
  GroupbuyActivityForm,
  GroupbuyActivitySkuInput,
  GroupbuyActivityStatus,
  GroupbuyGroupStatus,
  GroupbuyMemberRole,
  GroupbuyMemberStatus,
} from '@shop/contracts/groupbuy/schemas';

import { MoneyInput } from '@/admin/kit/form/money-input';
import { ProductSelect } from '@/admin/kit/product-select';
import { SkuPicker } from '@/admin/kit/sku-picker';
import type { SortableItemHelpers } from '@/admin/kit/form/sortable-list-field';
import type { FieldSpec } from '@/admin/kit/form/types';
import type { StatusMap } from '@/admin/kit/status-tag';

/**
 * The group-buy domain's enums and form fields, in one file next to the pages.
 *
 * One `StatusMap` per enum, shared by the table column, the filter bar and the
 * form, so a label can never say 进行中 in one place and 已启用 in another. The
 * keys are the contract's own union members, so deleting a value from the
 * contract is a compile error here rather than a blank tag in production.
 */

export const GROUPBUY_ACTIVITY_STATUS: StatusMap<GroupbuyActivityStatus> = {
  draft: { label: '草稿', color: 'default' },
  active: { label: '进行中', color: 'success' },
  paused: { label: '已暂停', color: 'warning' },
  ended: { label: '已结束', color: 'default' },
};

export const GROUPBUY_GROUP_STATUS: StatusMap<GroupbuyGroupStatus> = {
  forming: { label: '拼团中', color: 'processing' },
  succeeded: { label: '已成团', color: 'success' },
  failed: { label: '未成团', color: 'error' },
  cancelled: { label: '已取消', color: 'default' },
};

export const GROUPBUY_MEMBER_STATUS: StatusMap<GroupbuyMemberStatus> = {
  joined: { label: '参团中', color: 'processing' },
  refunded: { label: '已退款', color: 'warning' },
  cancelled: { label: '已取消', color: 'default' },
};

export const GROUPBUY_MEMBER_ROLE: StatusMap<GroupbuyMemberRole> = {
  leader: { label: '团长', color: 'gold' },
  member: { label: '团员', color: 'default' },
};

/** A `StatusMap` as `<Select>` options, so a filter can never drift from a tag. */
export const optionsOf = <K extends string>(map: StatusMap<K>) =>
  (Object.keys(map) as K[]).map((value) => ({ label: map[value].label, value }));

/**
 * The 规格 cell: the kit's picker, with the typed-in id as the fallback.
 *
 * A group-buy SKU is a price and a stock ledger of its own, hanging off a
 * `product_skus.id`. Until A2 the id was typed in, which let an operator name
 * a real SKU of the *wrong* product — the server refuses it
 * (`GROUPBUY_SKU_NOT_IN_ACTIVITY`), but only after the form has been filled
 * in. 选择 opens `<SkuPicker>` scoped to the activity's own 商品 ID, so the
 * wrong product is not on offer in the first place.
 *
 * The id stays visible and stays editable: a migrated activity can carry a
 * SKU whose product is no longer on the shelf, and the picker (which lists
 * on-shelf products) would not be able to show it.
 */
function SkuIdField({
  value,
  disabled,
  onChange,
}: {
  value: string | undefined;
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
        style={{ width: 120 }}
        value={value ?? ''}
        placeholder="规格 ID"
        inputMode="numeric"
        disabled={disabled}
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
        productId={productId === undefined || productId === '' ? undefined : productId}
        onClose={() => setOpen(false)}
        onSelect={(picked) => {
          const first = picked[0];
          if (first !== undefined) onChange(first.skuId);
        }}
      />
    </>
  );
}

/** One row of the 规格 editor. */
function SkuRow(item: never, helpers: SortableItemHelpers<never>) {
  const sku = item as unknown as Partial<GroupbuyActivitySkuInput>;
  const set = (patch: Partial<GroupbuyActivitySkuInput>) =>
    helpers.set({ ...sku, ...patch } as unknown as never);

  return (
    <Space wrap size="middle">
      <Space size={4}>
        <Typography.Text type="secondary">规格</Typography.Text>
        <SkuIdField
          value={sku.skuId}
          disabled={helpers.disabled}
          onChange={(skuId) => set({ skuId })}
        />
      </Space>
      <Space size={4}>
        <Typography.Text type="secondary">拼团价</Typography.Text>
        <MoneyInput
          value={sku.price ?? ''}
          disabled={helpers.disabled}
          onChange={(value) => set({ price: value ?? '' })}
        />
      </Space>
      <Space size={4}>
        <Typography.Text type="secondary">库存</Typography.Text>
        <InputNumber
          min={0}
          value={sku.stock ?? 0}
          disabled={helpers.disabled}
          onChange={(value) => set({ stock: value ?? 0 })}
        />
      </Space>
      <Space size={4}>
        <Typography.Text type="secondary">限量</Typography.Text>
        <InputNumber
          min={0}
          placeholder="不限"
          value={sku.quota ?? null}
          disabled={helpers.disabled}
          onChange={(value) => set(value === null ? { quota: undefined } : { quota: value })}
        />
      </Space>
      <Space size={4}>
        <Typography.Text type="secondary">启用</Typography.Text>
        <Switch
          checked={sku.isEnabled ?? true}
          disabled={helpers.disabled}
          onChange={(checked) => set({ isEnabled: checked })}
        />
      </Space>
    </Space>
  );
}

/**
 * The create/edit form.
 *
 * Every rule comes from `groupbuyActivityForm` — the window ordering, the
 * two-person minimum and the duplicate-SKU check, which mirror
 * `groupbuy_activities_window_ordered`, `groupbuy_activities_seats_required`
 * and `groupbuy_activity_skus_uq`. This list only says how each field is typed
 * in.
 *
 * 拼团有效时长 is typed in seconds, the unit the contract validates, rather
 * than in hours with a conversion: `ZodForm` runs `groupbuyActivityForm` in the
 * browser, so a converted field would fail its own `min(60)` before anything
 * had a chance to multiply it. The help text carries the arithmetic instead.
 */
export const groupbuyActivityFields: FieldSpec<Extract<keyof GroupbuyActivityForm, string>>[] = [
  // Ids cross the wire as decimal strings (CONVENTIONS); the picker hands back the string.
  {
    kind: 'custom',
    name: 'productId',
    label: '商品',
    span: 12,
    help: '拼团挂在已有商品上；选好后用下面每行的「选择」挑规格',
    render: ({ value, onChange, disabled, id }) => (
      <ProductSelect
        id={id}
        value={typeof value === 'string' ? value : undefined}
        onChange={onChange}
        disabled={disabled}
      />
    ),
  },
  { kind: 'text', name: 'title', label: '活动标题', span: 12, placeholder: '三人成团 · 坚果礼盒' },
  {
    kind: 'select',
    name: 'status',
    label: '状态',
    span: 6,
    options: optionsOf(GROUPBUY_ACTIVITY_STATUS),
    help: '草稿不会出现在拼团频道',
  },

  { kind: 'text', name: 'intro', label: '活动简介', span: 12, maxLength: 255 },
  { kind: 'asset', name: 'imageUrl', label: '推荐图', span: 6 },
  { kind: 'asset', name: 'sliderImages', label: '轮播图', span: 6, multiple: true, max: 10 },

  { kind: 'money', name: 'price', label: '拼团价', span: 6 },
  { kind: 'money', name: 'originalPrice', label: '划线价', span: 6 },
  { kind: 'money', name: 'cost', label: '成本价', span: 6, help: '仅用于统计，不对外显示' },
  { kind: 'number', name: 'sortOrder', label: '排序', span: 6, min: 0 },

  {
    kind: 'number',
    name: 'seatsRequired',
    label: '成团人数',
    span: 6,
    min: 2,
    max: 100,
    help: '至少 2 人',
  },
  {
    kind: 'number',
    name: 'groupTtlSeconds',
    label: '拼团有效时长',
    span: 6,
    min: 60,
    max: 30 * 24 * 3600,
    addonAfter: '秒',
    help: '开团后多久未满员即失败退款；86400 = 24 小时',
  },
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
    help: '留空表示只受库存限制',
  },

  { kind: 'number', name: 'perOrderQuantity', label: '每单限购', span: 6, min: 1, max: 999 },
  { kind: 'date', name: 'startAt', label: '开始时间', span: 6, showTime: true },
  { kind: 'date', name: 'endAt', label: '结束时间', span: 6, showTime: true },
  {
    kind: 'text',
    name: 'shippingTemplateId',
    label: '运费模板 ID',
    span: 6,
    help: '留空则跟随商品',
  },

  {
    kind: 'sortableList',
    name: 'skus',
    label: '规格拼团价',
    span: 24,
    addText: '添加规格',
    emptyText: '未配置规格时，全部规格都按上面的拼团价售卖',
    max: 200,
    newItem: () => ({ skuId: '', price: '', stock: 0, isEnabled: true }),
    renderItem: SkuRow,
  },
];
