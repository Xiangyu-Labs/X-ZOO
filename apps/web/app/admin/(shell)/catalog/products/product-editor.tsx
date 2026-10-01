'use client';

import { Alert, Badge, Button, Form, Skeleton, Tooltip } from 'antd';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  catalogAdminProductCreate,
  catalogAdminProductDetail,
  catalogAdminProductList,
  catalogAdminProductUpdate,
} from '@shop/contracts/catalog/catalog.product.admin.contract';
import {
  catalogAdminLabelList,
  catalogAdminParamTemplateList,
  catalogAdminProtectionList,
} from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import { shippingTemplateOptionList } from '@shop/contracts/shipping/shipping.template.admin.contract';
import {
  adminProductForm,
  type AdminProductDetail,
  type AdminProductForm,
  type ProductKind,
  type ProductParam,
  type ProductSkuInput,
  type ProductSpecInput,
} from '@shop/contracts/catalog/schemas';

import { LoadFailure } from '@/admin/kit/load-failure';
import { useRouteMutation, useRouteQuery } from '@/admin/api/hooks';
import { useCan } from '@/admin/session/session-provider';
import type { FieldSpec, SelectOption } from '@/admin/kit/form/types';
import { ZodForm } from '@/admin/kit/form/zod-form';
import { useLeaveGuard } from '@/admin/kit/leave-guard';
import { PageContainer } from '@/admin/kit/page-container';
import { ProductSelect } from '@/admin/kit/product-select';
import { useSaveShortcut } from '@/admin/kit/save-shortcut';
import { useListReturn } from '@/admin/kit/table/list-return';

import {
  CATEGORY_TREE_CACHE_KEY,
  PRODUCT_FREIGHT_MODE,
  PRODUCT_KIND,
  PRODUCT_PURCHASE_LIMIT_MODE,
  PRODUCT_STATUS,
  loadCategoryTreeOptions,
  options,
} from '../catalog-enums';
import { SHIPPING_CHARGE_MODE } from '../../shipping/shipping-enums';
import { ParamEditor, SkuMatrixEditor, SpecEditor, blankSku } from './product-sku-editor';

/**
 * 新建 / 编辑商品 — one component for both, because they are one form.
 *
 * The whole thing is `adminProductForm`: required markers, ranges and the
 * cross-field rules that mirror the table CHECKs (`products_freight_source`,
 * `products_limit_quantity`, the SKU rules) all come from the contract, so the
 * browser and the server agree by construction and an impossible product is a
 * field error rather than a 500 from a constraint violation.
 *
 * The three things the kit cannot express declaratively — the spec axes, the
 * SKU matrix and the parameter rows — are `custom` fields backed by the
 * controls in `product-sku-editor.tsx`. They are still form fields: the form
 * owns the value, the contract validates it.
 */
export function ProductEditorPage({ productId }: { productId?: string | undefined }) {
  const router = useRouter();
  const { listHref, keepList } = useListReturn('/admin/catalog/products');
  const [form] = Form.useForm();
  // A role that may only look at products sees the form read-only, with no 保存
  // to press into a 403 — and without the option lists it has no right to.
  const can = useCan();
  const mayWrite = can('catalog:product:write');
  // The server blanks 成本价 for a role that may neither edit nor export; an
  // empty box would read as "no cost recorded", so the column goes instead.
  const showCost = mayWrite || can('catalog:product:export');

  // Always a fresh read: the form takes its values once, at mount, and a
  // cached detail from before a 下架 in the list would put the product back on
  // the shelf on the next 保存.
  const detail = useRouteQuery(
    catalogAdminProductDetail,
    { params: { id: productId ?? '' } },
    { enabled: productId !== undefined, refetchOnMount: 'always' },
  );

  // The three taxonomies the form offers as options: the first 100 enabled,
  // which is the list cap and more than any shop has.
  const labels = useRouteQuery(
    catalogAdminLabelList,
    { query: { page: 1, pageSize: 100, isEnabled: 'true' } },
    { enabled: mayWrite },
  );
  const protections = useRouteQuery(
    catalogAdminProtectionList,
    { query: { page: 1, pageSize: 100, isEnabled: 'true' } },
    { enabled: mayWrite },
  );
  const paramTemplates = useRouteQuery(
    catalogAdminParamTemplateList,
    { query: { page: 1, pageSize: 100, isEnabled: 'true' } },
    { enabled: mayWrite },
  );
  // The shipping options route: id, name and 计费方式, every template, no paging.
  const shippingTemplates = useRouteQuery(shippingTemplateOptionList, {}, { enabled: mayWrite });

  // Something typed since the last save: leaving asks first, the bar says so.
  const [dirty, setDirty] = useState(false);
  const leave = useLeaveGuard(dirty && mayWrite);

  const create = useRouteMutation(catalogAdminProductCreate, {
    presentError: false,
    invalidate: [catalogAdminProductList],
    successMessage: '已创建',
    onSuccess: (data) => {
      setDirty(false);
      router.replace(keepList(`/admin/catalog/products/${data.id}`));
    },
  });
  const update = useRouteMutation(catalogAdminProductUpdate, {
    presentError: false,
    invalidate: [catalogAdminProductList, catalogAdminProductDetail],
    successMessage: '已保存',
    onSuccess: () => setDirty(false),
  });
  const saving = create.isPending || update.isPending;
  const save = useCallback(() => form.submit(), [form]);
  useSaveShortcut(save, mayWrite);

  // Drives the spec/SKU controls and the mode-dependent fields below.
  const specMode = Form.useWatch<boolean | undefined>('specMode', form) ?? false;
  const kind = (Form.useWatch<ProductKind | undefined>('kind', form) ?? 'physical') as ProductKind;
  const specs = (Form.useWatch<ProductSpecInput[] | undefined>('specs', form) ??
    []) as ProductSpecInput[];
  const freightMode = Form.useWatch<string | undefined>('freightMode', form);
  const purchaseLimitMode = Form.useWatch<string | undefined>('purchaseLimitMode', form);

  /**
   * Clear the fields the current mode does not use.
   *
   * antd keeps the value of an unmounted `Form.Item`, and the contract refuses
   * a fixed freight on a template product ("当前计费方式不需要固定运费"). Without
   * this, switching 固定运费 → 运费模板 leaves the old number in the payload and
   * the save fails with an error about a field the operator cannot see.
   *
   * `undefined` means the watch has not reported yet, on the render before the
   * initial values reach it — clearing then would wipe the template id the
   * product was loaded with.
   */
  useEffect(() => {
    if (freightMode === undefined) return;
    if (freightMode !== 'fixed') form.setFieldValue('fixedFreight', undefined);
    if (freightMode !== 'template') form.setFieldValue('shippingTemplateId', undefined);
  }, [freightMode, form]);

  useEffect(() => {
    if (purchaseLimitMode === 'none') form.setFieldValue('purchaseLimitQuantity', undefined);
  }, [purchaseLimitMode, form]);

  const labelOptions: SelectOption[] = (labels.data?.items ?? []).map((row) => ({
    label: row.name,
    value: row.id,
  }));
  const protectionOptions: SelectOption[] = (protections.data?.items ?? []).map((row) => ({
    label: row.title,
    value: row.id,
  }));
  /**
   * 运费模板 — the shipping options route, not a typed id.
   *
   * The select carries the template's 计费方式 in its label because the same
   * template name can charge by 件 or by 重量 and the operator picking one from
   * the product form has no other way to tell.
   */
  const shippingTemplateOptions: SelectOption[] = (shippingTemplates.data?.items ?? []).map(
    (row) => ({
      label: `${row.name}（${SHIPPING_CHARGE_MODE[row.chargeMode].label}）`,
      value: row.id,
    }),
  );
  const templates = useMemo(
    () =>
      (paramTemplates.data?.items ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        suggestedValues: row.suggestedValues,
      })),
    [paramTemplates.data],
  );

  const fields = useMemo(
    () =>
      buildFields({
        labelOptions,
        protectionOptions,
        shippingTemplateOptions,
        templates,
        specs,
        specMode,
        kind,
        showCost,
      }),
    // `labelOptions`/`protectionOptions` are rebuilt every render; their data is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      labels.data,
      protections.data,
      shippingTemplates.data,
      templates,
      specs,
      specMode,
      kind,
      showCost,
    ],
  );

  if (productId !== undefined && (detail.isPending || !detail.isFetchedAfterMount)) {
    return (
      <PageContainer title="编辑商品">
        <Skeleton active paragraph={{ rows: 8 }} />
      </PageContainer>
    );
  }

  if (productId !== undefined && detail.isError) {
    return (
      <PageContainer title="编辑商品">
        <LoadFailure error={detail.error} onRetry={() => detail.refetch()} />
      </PageContainer>
    );
  }

  const record = detail.data;

  return (
    <PageContainer
      title={record ? `编辑商品：${record.name}` : '新建商品'}
      subTitle="规格一旦有销量就不要删；改名和改价不会影响已下单的订单"
      breadcrumb={[{ label: '商品', href: listHref }, { label: record ? '编辑商品' : '新建商品' }]}
      // On the page's bottom edge, always in reach: the form is five cards long.
      footer={
        <>
          {mayWrite ? (
            <span style={{ marginRight: 'auto', alignSelf: 'center' }}>
              {dirty ? (
                <Badge status="warning" text="有未保存的修改" />
              ) : (
                <Badge status="default" text="没有未保存的修改" />
              )}
            </span>
          ) : null}
          <Button onClick={() => leave(listHref)}>返回列表</Button>
          {mayWrite ? (
            <Tooltip title="Ctrl / ⌘ + S">
              <Button type="primary" loading={saving} onClick={save}>
                保存
              </Button>
            </Tooltip>
          ) : null}
        </>
      }
    >
      {mayWrite ? null : (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="你的身份只能查看商品，不能在这里修改"
        />
      )}
      <ZodForm
        disabled={!mayWrite}
        form={form}
        schema={adminProductForm}
        fields={fields}
        columns={2}
        initialValues={record ? formValuesOf(record) : NEW_PRODUCT}
        submitting={saving}
        error={create.error ?? update.error}
        footer={false}
        onValuesChange={() => setDirty(true)}
        onSubmit={(values) => {
          // `customForm` has no editor yet, so it is carried across untouched
          // rather than dropped.
          const body: AdminProductForm = {
            ...values,
            ...(record?.customForm ? { customForm: record.customForm } : {}),
          };
          if (record) update.mutate({ params: { id: record.id }, body });
          else create.mutate({ body });
        }}
      />
    </PageContainer>
  );
}

/** A new product starts as a draft with one implicit SKU, which is the common case. */
const NEW_PRODUCT: Partial<AdminProductForm> = {
  kind: 'physical',
  status: 'draft',
  specMode: false,
  specs: [],
  skus: [blankSku()],
  freightMode: 'template',
  purchaseLimitMode: 'none',
  minPurchaseQuantity: 1,
  displaySalesBoost: 0,
  sortOrder: 0,
  sliderImages: [],
  categoryIds: [],
  labelIds: [],
  protectionIds: [],
  params: [],
  recommendedProductIds: [],
  giftCouponIds: [],
  descriptionHtml: '',
};

function buildFields({
  labelOptions,
  protectionOptions,
  shippingTemplateOptions,
  templates,
  specs,
  specMode,
  kind,
  showCost,
}: {
  labelOptions: SelectOption[];
  protectionOptions: SelectOption[];
  shippingTemplateOptions: SelectOption[];
  templates: readonly { id: string; name: string; suggestedValues: string | null }[];
  specs: readonly ProductSpecInput[];
  specMode: boolean;
  kind: ProductKind;
  showCost: boolean;
}): FieldSpec<Extract<keyof AdminProductForm, string>>[] {
  return [
    {
      kind: 'text',
      name: 'name',
      section: '基本信息',
      label: '商品名称',
      span: 12,
      maxLength: 128,
    },
    {
      kind: 'text',
      name: 'subtitle',
      section: '基本信息',
      label: '商品简介',
      span: 12,
      maxLength: 255,
    },
    {
      kind: 'select',
      name: 'kind',
      section: '基本信息',
      label: '商品类型',
      span: 8,
      options: options(PRODUCT_KIND),
      help: '卡密商品的库存来自导入的卡密，虚拟商品不计运费',
    },
    {
      kind: 'select',
      name: 'status',
      section: '基本信息',
      label: '状态',
      span: 8,
      options: options(PRODUCT_STATUS),
    },
    {
      kind: 'text',
      name: 'unitName',
      section: '基本信息',
      label: '单位',
      span: 8,
      maxLength: 32,
      placeholder: '件',
    },
    { kind: 'text', name: 'spu', section: '基本信息', label: 'SPU 编码', span: 8, maxLength: 32 },
    {
      kind: 'text',
      name: 'barCode',
      section: '基本信息',
      label: '商品条码',
      span: 8,
      maxLength: 32,
    },
    {
      kind: 'text',
      name: 'keyword',
      section: '基本信息',
      label: '搜索关键字',
      span: 8,
      maxLength: 255,
      help: '与商品名一起参与搜索，空格分隔',
    },

    {
      kind: 'treeSelect',
      name: 'categoryIds',
      section: '基本信息',
      label: '商品分类',
      span: 12,
      multiple: true,
      loadOptions: loadCategoryTreeOptions,
      cacheKey: CATEGORY_TREE_CACHE_KEY,
      help: '至少一个；分类决定前台的入口和优惠券的适用范围',
    },
    {
      kind: 'select',
      name: 'labelIds',
      section: '基本信息',
      label: '商品标签',
      span: 12,
      mode: 'multiple',
      options: labelOptions,
      allowClear: true,
    },
    {
      kind: 'select',
      name: 'protectionIds',
      section: '基本信息',
      label: '保障服务',
      span: 12,
      mode: 'multiple',
      options: protectionOptions,
      allowClear: true,
    },

    { kind: 'asset', name: 'imageUrl', section: '图片与视频', label: '商品主图', span: 12 },
    {
      kind: 'asset',
      name: 'cardImageUrl',
      section: '图片与视频',
      label: '拼团/秒杀封面',
      span: 12,
      visibleWhen: (values) => values.kind !== 'physical',
    },
    {
      kind: 'asset',
      name: 'sliderImages',
      section: '图片与视频',
      label: '轮播图',
      span: 24,
      multiple: true,
      max: 10,
    },
    {
      kind: 'text',
      name: 'videoUrl',
      section: '图片与视频',
      label: '主图视频',
      span: 12,
      maxLength: 512,
      placeholder: 'https://…',
    },
    {
      kind: 'money',
      name: 'originalPrice',
      section: '价格与规格',
      label: '划线价',
      span: 6,
      help: '仅用于展示；真实售价在规格里',
    },
    {
      kind: 'number',
      name: 'sortOrder',
      section: '基本信息',
      label: '排序',
      span: 6,
      min: 0,
      max: 9999,
    },

    {
      kind: 'switch',
      name: 'specMode',
      section: '价格与规格',
      label: '多规格',
      span: 24,
      checkedText: '多规格',
      uncheckedText: '单规格',
      help: '关闭时商品只有一条库存记录；切换会重建下面的规格表',
    },
    {
      kind: 'custom',
      name: 'specs',
      section: '价格与规格',
      label: '规格项',
      span: 24,
      visibleWhen: (values) => values.specMode === true,
      render: ({ value, onChange, disabled }) => (
        <SpecEditor
          value={value as ProductSpecInput[] | undefined}
          onChange={onChange}
          disabled={disabled}
        />
      ),
    },
    {
      kind: 'custom',
      name: 'skus',
      section: '价格与规格',
      label: specMode ? '规格明细' : '价格与库存',
      span: 24,
      render: ({ value, onChange, disabled }) => (
        <SkuMatrixEditor
          value={value as ProductSkuInput[] | undefined}
          onChange={onChange}
          specs={specs}
          specMode={specMode}
          kind={kind}
          showCost={showCost}
          disabled={disabled}
        />
      ),
    },

    {
      kind: 'radio',
      name: 'freightMode',
      section: '运费与限购',
      label: '运费',
      span: 8,
      optionType: 'button',
      options: options(PRODUCT_FREIGHT_MODE),
    },
    {
      kind: 'money',
      name: 'fixedFreight',
      section: '运费与限购',
      label: '固定运费',
      span: 8,
      visibleWhen: (values) => values.freightMode === 'fixed',
      // The order charges `postage × quantity`: the
      // number below is per unit, not per order. Operators read "固定运费 8 元"
      // as "8 元 regardless of quantity" unless the form says otherwise.
      help: '按件收取：下单数量 × 该金额',
    },
    {
      kind: 'select',
      name: 'shippingTemplateId',
      section: '运费与限购',
      label: '运费模板',
      span: 8,
      options: shippingTemplateOptions,
      showSearch: true,
      allowClear: true,
      visibleWhen: (values) => values.freightMode === 'template',
      help: '在「物流 — 运费模板」里维护',
    },
    {
      kind: 'radio',
      name: 'purchaseLimitMode',
      section: '运费与限购',
      label: '限购',
      span: 8,
      optionType: 'button',
      options: options(PRODUCT_PURCHASE_LIMIT_MODE),
    },
    {
      kind: 'number',
      name: 'purchaseLimitQuantity',
      section: '运费与限购',
      label: '限购数量',
      span: 8,
      min: 1,
      max: 100_000,
      visibleWhen: (values) => values.purchaseLimitMode !== 'none',
    },
    {
      kind: 'number',
      name: 'minPurchaseQuantity',
      section: '运费与限购',
      label: '起购数量',
      span: 8,
      min: 1,
    },

    {
      kind: 'custom',
      name: 'recommendedProductIds',
      section: '营销',
      label: '推荐商品',
      span: 12,
      help: '详情页的「为你推荐」，按名称或 ID 搜索，最多 20 个',
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
      kind: 'select',
      name: 'giftCouponIds',
      section: '营销',
      label: '赠送优惠券 ID',
      span: 12,
      mode: 'tags',
      options: [],
      help: '下单后自动发放，输入优惠券 ID 回车确认',
    },
    {
      kind: 'number',
      name: 'displaySalesBoost',
      section: '营销',
      label: '虚拟销量',
      span: 8,
      min: 0,
      help: '只加在前台展示的销量上，不影响真实销量统计',
    },
    { kind: 'switch', name: 'isHot', section: '营销', label: '热门', span: 4 },
    { kind: 'switch', name: 'isNew', section: '营销', label: '新品', span: 4 },
    { kind: 'switch', name: 'isBest', section: '营销', label: '精品', span: 4 },
    { kind: 'switch', name: 'isBenefit', section: '营销', label: '促销', span: 4 },
    { kind: 'switch', name: 'isRecommended', section: '营销', label: '推荐', span: 4 },

    {
      kind: 'custom',
      name: 'params',
      section: '详情',
      label: '商品参数',
      span: 24,
      render: ({ value, onChange, disabled }) => (
        <ParamEditor
          value={value as ProductParam[] | undefined}
          onChange={onChange}
          templates={templates}
          disabled={disabled}
        />
      ),
    },
    {
      kind: 'richText',
      name: 'descriptionHtml',
      section: '详情',
      label: '商品详情',
      span: 24,
      minHeight: 320,
    },
  ];
}

/**
 * The detail response as form input.
 *
 * Two shapes, not one: the detail carries ids and computed fields the form does
 * not own (`sales`, `views`, `skuCode` of an existing SKU), and every optional
 * field is `null` there and absent here — `exactOptionalPropertyTypes` means an
 * optional field is either missing or a real value, never `null`.
 *
 * The SKU rows keep their `specValues`, which is what the server matches an
 * incoming row to an existing SKU by; that is how editing a price leaves the
 * stock and the sales counter alone.
 */
export function formValuesOf(record: AdminProductDetail): Partial<AdminProductForm> {
  const skus: ProductSkuInput[] = record.skus.map((sku) => ({
    specValues: sku.specValues,
    skuCode: sku.skuCode,
    ...(sku.imageUrl === null ? {} : { imageUrl: sku.imageUrl }),
    price: sku.price,
    ...(sku.originalPrice === null ? {} : { originalPrice: sku.originalPrice }),
    ...(sku.cost === null ? {} : { cost: sku.cost }),
    stock: sku.stock,
    // What the operator is looking at: the server leaves an untouched stock
    // alone and refuses a changed one if orders moved it meanwhile.
    expectedStock: sku.stock,
    ...(sku.barCode === null ? {} : { barCode: sku.barCode }),
    ...(sku.weight === null ? {} : { weight: sku.weight }),
    ...(sku.volume === null ? {} : { volume: sku.volume }),
    isDefault: sku.isDefault,
    isVisible: sku.isVisible,
    sortOrder: sku.sortOrder,
  }));

  return {
    name: record.name,
    ...(record.subtitle === null ? {} : { subtitle: record.subtitle }),
    ...(record.keyword === null ? {} : { keyword: record.keyword }),
    ...(record.spu === null ? {} : { spu: record.spu }),
    ...(record.barCode === null ? {} : { barCode: record.barCode }),
    kind: record.kind,
    status: record.status,
    imageUrl: record.imageUrl,
    ...(record.cardImageUrl === null ? {} : { cardImageUrl: record.cardImageUrl }),
    sliderImages: record.sliderImages,
    ...(record.videoUrl === null ? {} : { videoUrl: record.videoUrl }),
    ...(record.unitName === null ? {} : { unitName: record.unitName }),
    ...(record.originalPrice === null ? {} : { originalPrice: record.originalPrice }),
    displaySalesBoost: record.displaySalesBoost,
    specMode: record.specMode,
    specs: record.specs.map((spec) => ({
      name: spec.name,
      values: spec.values.map((value) => ({
        value: value.value,
        ...(value.imageUrl === null ? {} : { imageUrl: value.imageUrl }),
      })),
    })),
    skus: skus.length > 0 ? skus : [blankSku()],
    freightMode: record.freightMode,
    ...(record.fixedFreight === null ? {} : { fixedFreight: record.fixedFreight }),
    ...(record.shippingTemplateId === null
      ? {}
      : { shippingTemplateId: record.shippingTemplateId }),
    purchaseLimitMode: record.purchaseLimitMode,
    ...(record.purchaseLimitQuantity === null
      ? {}
      : { purchaseLimitQuantity: record.purchaseLimitQuantity }),
    minPurchaseQuantity: record.minPurchaseQuantity,
    isHot: record.isHot,
    isNew: record.isNew,
    isBest: record.isBest,
    isBenefit: record.isBenefit,
    isRecommended: record.isRecommended,
    sortOrder: record.sortOrder,
    descriptionHtml: record.descriptionHtml,
    categoryIds: record.categoryIds,
    labelIds: record.labelIds,
    protectionIds: record.protectionIds,
    params: record.params.map((param, index) => ({
      name: param.name,
      value: param.value,
      templateId: param.templateId,
      sortOrder: index,
    })),
    recommendedProductIds: record.recommendedProductIds,
    giftCouponIds: record.giftCouponIds,
  };
}
