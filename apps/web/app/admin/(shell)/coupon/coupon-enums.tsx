'use client';

import { ProductSelect } from '@/admin/kit/product-select';
import type { StatusMap } from '@/admin/kit/status-tag';
import type { FieldSpec } from '@/admin/kit/form/types';
import type {
  CouponClaimMode,
  CouponScope,
  CouponTemplateForm,
  CouponTemplateStatus,
  CouponValidityMode,
  UserCouponSourceKind,
  UserCouponStatus,
} from '@shop/contracts/coupon/schemas';

import { CATEGORY_TREE_CACHE_KEY, loadCategoryTreeOptions } from '../catalog/catalog-enums';

/**
 * The coupon domain's enums and form fields, in one file next to the pages.
 *
 * One `StatusMap` per enum, shared by the table column, the filter bar and the
 * form, so a label can never say 进行中 in one place and 已启用 in another.
 * The keys are the contract's own union members, so deleting a value from the
 * contract is a compile error here rather than a blank tag in production.
 */

export const COUPON_STATUS: StatusMap<CouponTemplateStatus> = {
  draft: { label: '草稿', color: 'default' },
  active: { label: '进行中', color: 'success' },
  disabled: { label: '已停用', color: 'warning' },
};

export const COUPON_SCOPE: StatusMap<CouponScope> = {
  all_products: { label: '全场通用', color: 'blue' },
  categories: { label: '指定分类', color: 'geekblue' },
  products: { label: '指定商品', color: 'purple' },
};

export const COUPON_CLAIM_MODE: StatusMap<CouponClaimMode> = {
  manual: { label: '手动领取', color: 'processing' },
  new_user: { label: '新人礼', color: 'cyan' },
  order_gift: { label: '下单赠送', color: 'gold' },
  admin_grant: { label: '后台发放', color: 'default' },
};

export const COUPON_VALIDITY_MODE: StatusMap<CouponValidityMode> = {
  fixed_window: { label: '固定期限', color: 'default' },
  days_after_claim: { label: '领取后生效', color: 'default' },
};

export const USER_COUPON_STATUS: StatusMap<UserCouponStatus> = {
  unused: { label: '未使用', color: 'processing' },
  used: { label: '已使用', color: 'success' },
  expired: { label: '已过期', color: 'default' },
  revoked: { label: '已作废', color: 'error' },
};

export const USER_COUPON_SOURCE: StatusMap<UserCouponSourceKind> = {
  claim: { label: '用户领取', color: 'default' },
  gift_order: { label: '下单赠送', color: 'gold' },
  gift_new_user: { label: '新人礼', color: 'cyan' },
  admin_grant: { label: '后台发放', color: 'blue' },
};

const options = <K extends string>(map: StatusMap<K>) =>
  (Object.keys(map) as K[]).map((value) => ({ label: map[value].label, value }));

/**
 * The create/edit form.
 *
 * Every rule comes from `couponAdminCreate.body` — required markers, ranges,
 * and the cross-field `superRefine` that mirrors the database CHECKs — so this
 * list only says how each field is *typed in*. `visibleWhen` hides the fields
 * a mode does not use, which is what stops an operator filling in both a fixed
 * window and a day count and being 422'd for it.
 *
 * Products and categories are entered as id lists.
 */
export const couponFields: FieldSpec<Extract<keyof CouponTemplateForm, string>>[] = [
  { kind: 'text', name: 'name', label: '名称', span: 12, placeholder: '满 100 减 10' },
  {
    kind: 'select',
    name: 'status',
    label: '状态',
    span: 6,
    options: options(COUPON_STATUS),
    help: '草稿不会出现在领券中心',
  },
  { kind: 'number', name: 'sortOrder', label: '排序', span: 6, min: 0 },

  { kind: 'money', name: 'discountAmount', label: '面额', span: 6 },
  { kind: 'money', name: 'minSpend', label: '使用门槛', span: 6, help: '0 表示无门槛' },
  {
    kind: 'select',
    name: 'scope',
    label: '适用范围',
    span: 12,
    options: options(COUPON_SCOPE),
  },
  {
    kind: 'custom',
    name: 'productIds',
    label: '指定商品',
    span: 12,
    visibleWhen: (values) => values.scope === 'products',
    help: '按名称或 ID 搜索，可选多个',
    render: ({ value, onChange, disabled, id }) => (
      <ProductSelect
        multiple
        id={id}
        value={Array.isArray(value) ? (value as string[]) : []}
        onChange={onChange}
        disabled={disabled}
      />
    ),
  },
  {
    kind: 'treeSelect',
    name: 'categoryIds',
    label: '指定分类',
    span: 12,
    multiple: true,
    withParents: true,
    loadOptions: loadCategoryTreeOptions,
    cacheKey: CATEGORY_TREE_CACHE_KEY,
    visibleWhen: (values) => values.scope === 'categories',
    help: '勾选上级分类时包含它下面的全部分类',
  },

  {
    kind: 'select',
    name: 'claimMode',
    label: '发放方式',
    span: 12,
    options: options(COUPON_CLAIM_MODE),
  },
  {
    kind: 'money',
    name: 'giftMinOrderAmount',
    label: '赠券订单门槛',
    span: 12,
    visibleWhen: (values) => values.claimMode === 'order_gift',
    help: '留空表示任意已支付订单都赠送',
  },

  {
    kind: 'select',
    name: 'validityMode',
    label: '有效期方式',
    span: 12,
    options: options(COUPON_VALIDITY_MODE),
  },
  {
    kind: 'date',
    name: 'validFrom',
    label: '有效期开始',
    span: 6,
    showTime: true,
    visibleWhen: (values) => values.validityMode === 'fixed_window',
  },
  {
    kind: 'date',
    name: 'validTo',
    label: '有效期结束',
    span: 6,
    showTime: true,
    visibleWhen: (values) => values.validityMode === 'fixed_window',
  },
  {
    kind: 'number',
    name: 'validDays',
    label: '领取后有效天数',
    span: 12,
    min: 1,
    max: 3650,
    visibleWhen: (values) => values.validityMode === 'days_after_claim',
  },

  { kind: 'date', name: 'claimFrom', label: '领取开始时间', span: 6, showTime: true },
  { kind: 'date', name: 'claimTo', label: '领取结束时间', span: 6, showTime: true },

  {
    kind: 'switch',
    name: 'isUnlimitedSupply',
    label: '不限量',
    span: 6,
    checkedText: '是',
    uncheckedText: '否',
  },
  {
    kind: 'number',
    name: 'totalCount',
    label: '发放总量',
    span: 6,
    min: 1,
    visibleWhen: (values) => !values.isUnlimitedSupply,
    help: '编辑时按差值调整剩余库存，不会把已领走的补回来',
  },
  {
    kind: 'number',
    name: 'perUserLimit',
    label: '每人限领',
    span: 6,
    min: 1,
    help: '留空表示不限',
  },
];
