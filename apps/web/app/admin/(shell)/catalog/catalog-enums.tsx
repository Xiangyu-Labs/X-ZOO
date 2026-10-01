'use client';

import { catalogAdminCategoryTree } from '@shop/contracts/catalog/catalog.category.admin.contract';
import type {
  AdminReviewForm,
  ProductCategoryForm,
  ProductFreightMode,
  ProductKind,
  ProductLabelCategoryForm,
  ProductLabelForm,
  ProductLabelStyle,
  ProductParamTemplateForm,
  ProductProtectionForm,
  ProductPurchaseLimitMode,
  ProductReviewStatus,
  ProductStatus,
  ProductVirtualCardState,
} from '@shop/contracts/catalog/schemas';

import { Button, Form, Input, Space, Typography } from 'antd';
import { useState } from 'react';

import { callRoute } from '@/admin/api/call-route';
import { SkuPicker, type PickedSku } from '@/admin/kit/sku-picker';
import type { FieldSpec, SelectOption } from '@/admin/kit/form/types';
import type { TreeOption } from '@/admin/kit/form/select-fields';
import type { StatusMap } from '@/admin/kit/status-tag';
import { useCan } from '@/admin/session/session-provider';

/**
 * The catalog's enums, form field lists and shared pickers, in one file next to
 * the pages that use them.
 *
 * One `StatusMap` per contract enum, keyed by the contract's own union members,
 * so a value removed from the contract is a compile error here rather than a
 * blank tag in production, and the table column, the filter bar and the form
 * can never disagree about what 已上架 is called or what colour it is.
 */

export const PRODUCT_STATUS: StatusMap<ProductStatus> = {
  draft: { label: '草稿', color: 'default' },
  on_shelf: { label: '出售中', color: 'success' },
  off_shelf: { label: '已下架', color: 'warning' },
};

/**
 * One `kind` rather than an `is_virtual` flag plus a `virtual_type`: two
 * columns can disagree, one cannot.
 */
export const PRODUCT_KIND: StatusMap<ProductKind> = {
  physical: { label: '实物商品', color: 'blue' },
  virtual_card: { label: '卡密商品', color: 'purple' },
  virtual_coupon: { label: '优惠券商品', color: 'gold' },
  virtual_manual: { label: '虚拟商品', color: 'cyan' },
};

export const PRODUCT_FREIGHT_MODE: StatusMap<ProductFreightMode> = {
  free: { label: '包邮', color: 'success' },
  fixed: { label: '固定运费', color: 'default' },
  template: { label: '运费模板', color: 'processing' },
};

export const PRODUCT_PURCHASE_LIMIT_MODE: StatusMap<ProductPurchaseLimitMode> = {
  none: { label: '不限购', color: 'default' },
  per_order: { label: '每单限购', color: 'processing' },
  lifetime: { label: '每人限购', color: 'warning' },
};

export const PRODUCT_LABEL_STYLE: StatusMap<ProductLabelStyle> = {
  text: { label: '文字', color: 'default' },
  image: { label: '图片', color: 'processing' },
};

export const REVIEW_STATUS: StatusMap<ProductReviewStatus> = {
  pending: { label: '待审核', color: 'warning' },
  published: { label: '已显示', color: 'success' },
  hidden: { label: '已隐藏', color: 'default' },
};

export const VIRTUAL_CARD_STATE: StatusMap<ProductVirtualCardState> = {
  unclaimed: { label: '未发放', color: 'processing' },
  claimed: { label: '已发放', color: 'success' },
  void: { label: '已作废', color: 'default' },
};

/** The 好评 / 中评 / 差评 grouping operators filter reviews by. */
export const REVIEW_RATING_OPTIONS: SelectOption[] = [
  { label: '好评（4-5 分）', value: 'good' },
  { label: '中评（3 分）', value: 'medium' },
  { label: '差评（1-2 分）', value: 'bad' },
];

export const BOOL_OPTIONS: SelectOption[] = [
  { label: '是', value: 'true' },
  { label: '否', value: 'false' },
];

export function options<K extends string>(map: StatusMap<K>): { label: string; value: K }[] {
  return (Object.keys(map) as K[]).map((value) => ({ label: map[value].label, value }));
}

// ---------------------------------------------------------------------------
// category picker
// ---------------------------------------------------------------------------

/**
 * The shape the tree is read through.
 *
 * The contract spells the three levels out one by one (a leaf has no
 * `children` key at all), which is right for OpenAPI and awkward for a
 * recursive walk; this is the same data seen structurally.
 */
interface CategoryTreeNode {
  id: string;
  name: string;
  isVisible: boolean;
  children?: readonly CategoryTreeNode[] | undefined;
}

function toTreeOptions(nodes: readonly CategoryTreeNode[]): TreeOption[] {
  return nodes.map((node) => ({
    title: node.isVisible ? node.name : `${node.name}（已隐藏）`,
    value: node.id,
    ...(node.children && node.children.length > 0
      ? { children: toTreeOptions(node.children) }
      : {}),
  }));
}

/**
 * The category tree as `TreeSelectField` options.
 *
 * Passed as `loadOptions` with a `cacheKey`, so the product editor, the
 * category form and the stock-warning filter share one cached fetch instead of
 * three. Hidden categories are included — an editor still has to be able to
 * reach a product filed under one.
 */
export async function loadCategoryTreeOptions(): Promise<TreeOption[]> {
  const tree = await callRoute(catalogAdminCategoryTree, { query: {} });
  return toTreeOptions(tree.items);
}

export const CATEGORY_TREE_CACHE_KEY = 'catalog.categories';

// ---------------------------------------------------------------------------
// forms
// ---------------------------------------------------------------------------

/**
 * 商品分类.
 *
 * `parentId` is a tree picker rather than a select of everything: the tree is
 * three levels deep by contract, and picking "男装 → 上衣" out of a flat list of
 * two hundred names is how operators filed things under the wrong parent.
 */
export const categoryFields: FieldSpec<Extract<keyof ProductCategoryForm, string>>[] = [
  {
    kind: 'treeSelect',
    name: 'parentId',
    label: '上级分类',
    span: 12,
    loadOptions: loadCategoryTreeOptions,
    cacheKey: CATEGORY_TREE_CACHE_KEY,
    placeholder: '留空为一级分类',
    help: '最多三级；移动分类会一并移动它的子分类',
  },
  { kind: 'text', name: 'name', label: '分类名称', span: 12, maxLength: 100 },
  { kind: 'asset', name: 'iconUrl', label: '分类图标', span: 12 },
  { kind: 'asset', name: 'bannerUrl', label: '分类广告图', span: 12 },
  { kind: 'number', name: 'sortOrder', label: '排序', span: 12, min: 0, max: 9999 },
  {
    kind: 'switch',
    name: 'isVisible',
    label: '前台显示',
    span: 12,
    checkedText: '显示',
    uncheckedText: '隐藏',
  },
];

export const labelCategoryFields: FieldSpec<Extract<keyof ProductLabelCategoryForm, string>>[] = [
  { kind: 'text', name: 'name', label: '分类名称', span: 16, maxLength: 64 },
  { kind: 'number', name: 'sortOrder', label: '排序', span: 8, min: 0, max: 9999 },
];

/**
 * 商品标签.
 *
 * The colour fields are plain text because the contract stores whatever CSS
 * colour the storefront renders — a picker would quietly rewrite `#f00` and
 * `var(--brand)` alike.
 */
export function labelFields(
  categoryOptions: readonly SelectOption[],
): FieldSpec<Extract<keyof ProductLabelForm, string>>[] {
  return [
    { kind: 'text', name: 'name', label: '标签名称', span: 12, maxLength: 64 },
    {
      kind: 'select',
      name: 'categoryId',
      label: '标签分类',
      span: 12,
      options: categoryOptions,
      allowClear: true,
      placeholder: '未分类',
    },
    {
      kind: 'radio',
      name: 'style',
      label: '展示形式',
      span: 24,
      optionType: 'button',
      options: options(PRODUCT_LABEL_STYLE),
    },
    {
      kind: 'text',
      name: 'fontColor',
      label: '文字颜色',
      span: 8,
      placeholder: '#ffffff',
      visibleWhen: (values) => values.style !== 'image',
    },
    {
      kind: 'text',
      name: 'backgroundColor',
      label: '背景颜色',
      span: 8,
      placeholder: '#ff6a00',
      visibleWhen: (values) => values.style !== 'image',
    },
    {
      kind: 'text',
      name: 'borderColor',
      label: '边框颜色',
      span: 8,
      placeholder: '#ff6a00',
      visibleWhen: (values) => values.style !== 'image',
    },
    {
      kind: 'asset',
      name: 'imageUrl',
      label: '标签图片',
      span: 24,
      visibleWhen: (values) => values.style === 'image',
      help: '图片标签必须上传图片，否则前台看不到这个标签',
    },
    { kind: 'number', name: 'sortOrder', label: '排序', span: 8, min: 0, max: 9999 },
    {
      kind: 'switch',
      name: 'isVisible',
      label: '前台显示',
      span: 8,
      checkedText: '显示',
      uncheckedText: '隐藏',
    },
    {
      kind: 'switch',
      name: 'isEnabled',
      label: '启用',
      span: 8,
      checkedText: '启用',
      uncheckedText: '停用',
    },
  ];
}

export const paramTemplateFields: FieldSpec<Extract<keyof ProductParamTemplateForm, string>>[] = [
  { kind: 'text', name: 'name', label: '参数名称', span: 16, maxLength: 64 },
  { kind: 'number', name: 'sortOrder', label: '排序', span: 8, min: 0, max: 9999 },
  {
    kind: 'textarea',
    name: 'suggestedValues',
    label: '可选值',
    span: 24,
    rows: 5,
    maxLength: 2000,
    showCount: true,
    help: '一行一个，编辑商品时作为下拉建议；留空表示自由填写',
  },
  {
    kind: 'switch',
    name: 'isEnabled',
    label: '启用',
    span: 8,
    checkedText: '启用',
    uncheckedText: '停用',
  },
];

export const protectionFields: FieldSpec<Extract<keyof ProductProtectionForm, string>>[] = [
  { kind: 'text', name: 'title', label: '服务名称', span: 16, maxLength: 64 },
  { kind: 'number', name: 'sortOrder', label: '排序', span: 8, min: 0, max: 9999 },
  { kind: 'asset', name: 'iconUrl', label: '图标', span: 24 },
  {
    kind: 'textarea',
    name: 'content',
    label: '服务说明',
    span: 24,
    rows: 4,
    maxLength: 2000,
    showCount: true,
    help: '商品详情页点开保障服务时展示的文字',
  },
  {
    kind: 'switch',
    name: 'isEnabled',
    label: '启用',
    span: 8,
    checkedText: '启用',
    uncheckedText: '停用',
  },
];

/**
 * 虚拟评价.
 *
 * `createdAt` is a real field rather than an oversight: a seeded review dated
 * today, on a shop that opened last year, fools nobody.
 */
export const reviewFields: FieldSpec<Extract<keyof AdminReviewForm, string>>[] = [
  {
    kind: 'custom',
    name: 'productId',
    label: '商品',
    span: 24,
    help: '选择商品规格后自动填写商品 ID 和规格 ID',
    render: ({ value, onChange, disabled }) => (
      <ReviewProductField
        value={typeof value === 'string' ? value : undefined}
        onChange={onChange}
        disabled={disabled}
      />
    ),
  },
  { kind: 'text', name: 'skuId', label: '规格 ID', span: 12, placeholder: '留空表示不指定规格' },
  { kind: 'text', name: 'authorNickname', label: '昵称', span: 12, maxLength: 64 },
  { kind: 'asset', name: 'authorAvatarUrl', label: '头像', span: 12 },
  { kind: 'number', name: 'productScore', label: '商品评分', span: 6, min: 1, max: 5 },
  { kind: 'number', name: 'serviceScore', label: '服务评分', span: 6, min: 1, max: 5 },
  { kind: 'date', name: 'createdAt', label: '评价时间', span: 12, showTime: true },
  {
    kind: 'textarea',
    name: 'content',
    label: '评价内容',
    span: 24,
    rows: 4,
    maxLength: 1000,
    showCount: true,
  },
  { kind: 'asset', name: 'images', label: '评价图片', span: 24, multiple: true, max: 9 },
];

/**
 * 虚拟评价's product: 选择商品规格 opens the `<SkuPicker>`, which fills both the
 * product and the SKU, so a mistyped id cannot land the review on the wrong
 * product. The id box stays editable for a product that is off the shelf
 * (the picker lists on-shelf products only). The picker reads the product
 * list, so a role that may write reviews but not read products types the id.
 */
function ReviewProductField({
  value,
  onChange,
  disabled,
}: {
  value: string | undefined;
  onChange: (value: unknown) => void;
  disabled: boolean;
}) {
  const form = Form.useFormInstance();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<PickedSku | null>(null);
  const canPick = useCan()('catalog:product:read');

  return (
    <Space wrap>
      <Input
        style={{ width: 140 }}
        value={value ?? ''}
        disabled={disabled}
        placeholder="商品 ID"
        aria-label="商品 ID"
        onChange={(event) => {
          setPicked(null);
          onChange(event.target.value);
        }}
      />
      {canPick ? (
        <Button disabled={disabled} onClick={() => setOpen(true)}>
          选择商品规格
        </Button>
      ) : null}
      {picked && picked.productId === value ? (
        <Typography.Text type="secondary">
          已选规格：{picked.specText || '单规格'}（¥{picked.price}）
        </Typography.Text>
      ) : null}
      {canPick ? (
        <SkuPicker
          open={open}
          multiple={false}
          title="选择评价的商品规格"
          onClose={() => setOpen(false)}
          onSelect={(skus) => {
            const first = skus[0];
            setOpen(false);
            if (first === undefined) return;
            setPicked(first);
            onChange(first.productId);
            form.setFieldValue('skuId', first.skuId);
          }}
        />
      ) : null}
    </Space>
  );
}
