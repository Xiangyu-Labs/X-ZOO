import { z } from 'zod';
import { id, idList, instant, money, pageQuery, paged, sortQuery } from '../_conventions/common';

/**
 * Shapes shared by the catalog routes.
 *
 * The enums are the PostgreSQL enums of `db/src/schema/catalog.ts`, spelled the
 * same way. They are *not* imported from `@shop/db` — contracts are the bottom
 * layer and may not depend on the database package — so the pair is kept honest
 * by `catalog.service.ts`, which assigns one to the other and stops compiling
 * if they drift.
 *
 * Two things are deliberately absent:
 *  - a virtual flag beside a virtual type code. What the buyer receives is one
 *    `kind`, so there is no flag that can disagree with the type. One enum, one
 *    meaning.
 *  - spec templates (规格模板). They are a convenience list of spec presets an
 *    operator can re-enter, so there are no spec-template routes here.
 */

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

/** What the buyer receives. */
export const productKind = z.enum(['physical', 'virtual_card', 'virtual_coupon', 'virtual_manual']);
export type ProductKind = z.infer<typeof productKind>;

export const productStatus = z.enum(['draft', 'on_shelf', 'off_shelf']);
export type ProductStatus = z.infer<typeof productStatus>;

/** Free shipping, a fixed amount per unit, or a shipping template. */
export const productFreightMode = z.enum(['free', 'fixed', 'template']);
export type ProductFreightMode = z.infer<typeof productFreightMode>;

/** No limit, a cap per order, or a cap over the buyer's lifetime. */
export const productPurchaseLimitMode = z.enum(['none', 'per_order', 'lifetime']);
export type ProductPurchaseLimitMode = z.infer<typeof productPurchaseLimitMode>;

export const productLabelStyle = z.enum(['text', 'image']);
export type ProductLabelStyle = z.infer<typeof productLabelStyle>;

export const productReviewStatus = z.enum(['pending', 'published', 'hidden']);
export type ProductReviewStatus = z.infer<typeof productReviewStatus>;

export const productVirtualCardState = z.enum(['unclaimed', 'claimed', 'void']);
export type ProductVirtualCardState = z.infer<typeof productVirtualCardState>;

/** A field of the buyer-filled form some products attach to checkout. */
export const productCustomFormFieldType = z.enum([
  'text',
  'textarea',
  'number',
  'date',
  'select',
  'radio',
  'checkbox',
  'image',
]);

export const productCustomFormField = z.object({
  key: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, '字段标识只能是字母、数字和下划线'),
  label: z.string().trim().min(1).max(32),
  type: productCustomFormFieldType,
  required: z.boolean(),
  options: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  placeholder: z.string().max(64).optional(),
});
export type ProductCustomFormField = z.infer<typeof productCustomFormField>;

// ---------------------------------------------------------------------------
// scalars that are neither money nor an id
// ---------------------------------------------------------------------------

/**
 * Kilograms, `numeric(12,3)`. A decimal string for the same reason money is:
 * `0.1 + 0.2` must not decide a freight band.
 */
export const weight = z.string().regex(/^(0|[1-9]\d{0,8})(\.\d{1,3})?$/, '重量格式不正确');
/** Cubic metres, `numeric(12,4)`. */
export const volume = z.string().regex(/^(0|[1-9]\d{0,7})(\.\d{1,4})?$/, '体积格式不正确');

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

export const productCategory = z.object({
  id,
  parentId: id.nullable(),
  name: z.string(),
  /** Materialised ancestor path, `/3/17/`. Root categories have `/`. */
  path: z.string(),
  /** 0 for a root category. */
  level: z.number().int().min(0),
  iconUrl: z.string().nullable(),
  bannerUrl: z.string().nullable(),
  sortOrder: z.number().int(),
  isVisible: z.boolean(),
  /** Live products mapped to this category, for the admin list's 商品数 column. */
  productCount: z.number().int().min(0),
  createdAt: instant,
});
export type ProductCategory = z.infer<typeof productCategory>;

/**
 * The tree, three levels deep and no deeper.
 *
 * Written out rather than recursed with `z.lazy`: the tree is capped at three
 * levels (`CATALOG_CATEGORY_TOO_DEEP`), OpenAPI generation of a lazy schema is
 * a `$ref` cycle, and a fixed depth is the one shape a `cascader`/`treeSelect`
 * can consume without a runtime guard.
 */
export const productCategoryLeaf = productCategory;
export const productCategoryBranch = productCategory.extend({
  children: z.array(productCategoryLeaf),
});
export const productCategoryNode = productCategory.extend({
  children: z.array(productCategoryBranch),
});
export type ProductCategoryNode = z.infer<typeof productCategoryNode>;

export const productCategoryTree = z.object({ items: z.array(productCategoryNode) });

export const productCategoryForm = z
  .object({
    /** `null` / omitted makes a root category. */
    parentId: id.nullable().default(null),
    name: z.string().trim().min(1).max(100),
    iconUrl: z.string().max(512).optional(),
    bannerUrl: z.string().max(512).optional(),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    isVisible: z.boolean().default(true),
  })
  .strict();
export type ProductCategoryForm = z.infer<typeof productCategoryForm>;

export const productCategoryListQuery = pageQuery
  .extend({
    keyword: z.string().trim().max(64).optional(),
    /** Direct children of this category only. */
    parentId: id.optional(),
    isVisible: z.stringbool().optional(),
    level: z.coerce.number().int().min(0).max(2).optional(),
  })
  .extend(sortQuery(['id', 'sortOrder', 'name', 'createdAt']).shape);
export type ProductCategoryListQuery = z.infer<typeof productCategoryListQuery>;

export const pagedProductCategories = paged(productCategory);

export const productCategoryVisibilityBody = z.object({ isVisible: z.boolean() });

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

export const productLabelCategory = z.object({
  id,
  name: z.string(),
  sortOrder: z.number().int(),
  labelCount: z.number().int().min(0),
  createdAt: instant,
});
export type ProductLabelCategory = z.infer<typeof productLabelCategory>;

export const productLabelCategoryForm = z
  .object({
    name: z.string().trim().min(1).max(64),
    sortOrder: z.number().int().min(0).max(9999).default(0),
  })
  .strict();
export type ProductLabelCategoryForm = z.infer<typeof productLabelCategoryForm>;

export const productLabelCategoryListQuery = pageQuery
  .extend({ keyword: z.string().trim().max(64).optional() })
  .extend(sortQuery(['id', 'sortOrder', 'name']).shape);

export const pagedProductLabelCategories = paged(productLabelCategory);

/** How a label renders on a product card. */
export const productLabel = z.object({
  id,
  categoryId: id.nullable(),
  categoryName: z.string().nullable(),
  name: z.string(),
  style: productLabelStyle,
  fontColor: z.string().nullable(),
  backgroundColor: z.string().nullable(),
  borderColor: z.string().nullable(),
  imageUrl: z.string().nullable(),
  isVisible: z.boolean(),
  isEnabled: z.boolean(),
  sortOrder: z.number().int(),
  /** How many live products carry it. */
  productCount: z.number().int().min(0),
  createdAt: instant,
});
export type ProductLabel = z.infer<typeof productLabel>;

/** The trimmed shape a storefront product card carries. */
export const productCardLabel = z.object({
  id,
  name: z.string(),
  style: productLabelStyle,
  fontColor: z.string().nullable(),
  backgroundColor: z.string().nullable(),
  borderColor: z.string().nullable(),
  imageUrl: z.string().nullable(),
});
export type ProductCardLabel = z.infer<typeof productCardLabel>;

export const productLabelForm = z
  .object({
    categoryId: id.nullable().default(null),
    name: z.string().trim().min(1).max(64),
    style: productLabelStyle.default('text'),
    fontColor: z.string().max(32).optional(),
    backgroundColor: z.string().max(32).optional(),
    borderColor: z.string().max(32).optional(),
    imageUrl: z.string().max(512).optional(),
    isVisible: z.boolean().default(true),
    isEnabled: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(9999).default(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Mirrors what the storefront renderer needs: an image label with no image
    // is an invisible label, and the operator should hear that now.
    if (value.style === 'image' && !value.imageUrl) {
      ctx.addIssue({ code: 'custom', path: ['imageUrl'], message: '图片标签必须上传图片' });
    }
  });
export type ProductLabelForm = z.infer<typeof productLabelForm>;

export const productLabelListQuery = pageQuery
  .extend({
    keyword: z.string().trim().max(64).optional(),
    categoryId: id.optional(),
    isEnabled: z.stringbool().optional(),
  })
  .extend(sortQuery(['id', 'sortOrder', 'name', 'createdAt']).shape);

export const pagedProductLabels = paged(productLabel);

export const productLabelEnabledBody = z.object({ isEnabled: z.boolean() });

// ---------------------------------------------------------------------------
// param templates
// ---------------------------------------------------------------------------

export const productParamTemplate = z.object({
  id,
  name: z.string(),
  /** Newline-separated suggested values. */
  suggestedValues: z.string().nullable(),
  isEnabled: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: instant,
});
export type ProductParamTemplate = z.infer<typeof productParamTemplate>;

export const productParamTemplateForm = z
  .object({
    name: z.string().trim().min(1).max(64),
    suggestedValues: z.string().max(2000).optional(),
    isEnabled: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(9999).default(0),
  })
  .strict();
export type ProductParamTemplateForm = z.infer<typeof productParamTemplateForm>;

export const productParamTemplateListQuery = pageQuery
  .extend({
    keyword: z.string().trim().max(64).optional(),
    isEnabled: z.stringbool().optional(),
  })
  .extend(sortQuery(['id', 'sortOrder', 'name']).shape);

export const pagedProductParamTemplates = paged(productParamTemplate);

export const productParamTemplateEnabledBody = z.object({ isEnabled: z.boolean() });

/** One parameter as it appears on a product. */
export const productParam = z.object({
  name: z.string().trim().min(1).max(64),
  value: z.string().trim().min(1).max(255),
  templateId: id.nullable().default(null),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type ProductParam = z.infer<typeof productParam>;

// ---------------------------------------------------------------------------
// protections
// ---------------------------------------------------------------------------

export const productProtection = z.object({
  id,
  title: z.string(),
  content: z.string().nullable(),
  iconUrl: z.string().nullable(),
  isEnabled: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: instant,
});
export type ProductProtection = z.infer<typeof productProtection>;

export const productProtectionForm = z
  .object({
    title: z.string().trim().min(1).max(64),
    content: z.string().max(2000).optional(),
    iconUrl: z.string().max(512).optional(),
    isEnabled: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(9999).default(0),
  })
  .strict();
export type ProductProtectionForm = z.infer<typeof productProtectionForm>;

export const productProtectionListQuery = pageQuery
  .extend({
    keyword: z.string().trim().max(64).optional(),
    isEnabled: z.stringbool().optional(),
  })
  .extend(sortQuery(['id', 'sortOrder', 'title']).shape);

export const pagedProductProtections = paged(productProtection);

export const productProtectionEnabledBody = z.object({ isEnabled: z.boolean() });

// ---------------------------------------------------------------------------
// specs and SKUs
// ---------------------------------------------------------------------------

export const productSpecValueInput = z.object({
  value: z.string().trim().min(1).max(64),
  imageUrl: z.string().max(512).optional(),
});

export const productSpecInput = z.object({
  name: z.string().trim().min(1).max(64),
  values: z.array(productSpecValueInput).min(1).max(50),
});
export type ProductSpecInput = z.infer<typeof productSpecInput>;

export const productSpec = z.object({
  id,
  name: z.string(),
  sortOrder: z.number().int(),
  values: z.array(
    z.object({
      id,
      value: z.string(),
      imageUrl: z.string().nullable(),
      sortOrder: z.number().int(),
    }),
  ),
});
export type ProductSpec = z.infer<typeof productSpec>;

export const productSku = z.object({
  id,
  /** Stable, opaque, globally unique variant key. Carried on cart rows and order items. */
  skuCode: z.string(),
  /** `红|XL`; the empty string for a single-spec product. */
  specText: z.string(),
  /** `{ "颜色": "红", "尺码": "XL" }`; `{}` for a single-spec product. */
  specValues: z.record(z.string(), z.string()),
  imageUrl: z.string().nullable(),
  price: money,
  originalPrice: money.nullable(),
  cost: money.nullable(),
  stock: z.number().int().min(0),
  sales: z.number().int().min(0),
  barCode: z.string().nullable(),
  weight: weight.nullable(),
  volume: volume.nullable(),
  isDefault: z.boolean(),
  isVisible: z.boolean(),
  sortOrder: z.number().int(),
});
export type ProductSku = z.infer<typeof productSku>;

/**
 * One row of the spec matrix as the editor posts it.
 *
 * `specValues` is the identity: the server matches an incoming row to an
 * existing SKU by the joined spec text, so renaming a price does not orphan the
 * stock and the sales counter. A row whose combination is new is inserted; an
 * existing SKU whose combination is missing is removed.
 */
export const productSkuInput = z.object({
  specValues: z.record(z.string(), z.string()),
  skuCode: z.string().trim().max(32).optional(),
  imageUrl: z.string().max(512).optional(),
  price: money,
  originalPrice: money.optional(),
  cost: money.optional(),
  stock: z.number().int().min(0).max(1_000_000_000),
  /**
   * The stock the editor was showing when it loaded this SKU. With it, an
   * untouched stock is left alone (orders may have moved it meanwhile), and a
   * changed one is written only if the row still holds this number —
   * otherwise `CATALOG_SKU_STOCK_CHANGED`. Without it, `stock` is set as sent.
   */
  expectedStock: z.number().int().min(0).optional(),
  barCode: z.string().trim().max(50).optional(),
  weight: weight.optional(),
  volume: volume.optional(),
  isDefault: z.boolean().default(false),
  isVisible: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type ProductSkuInput = z.infer<typeof productSkuInput>;

/** Cartesian product of the spec axes, computed server-side so the editor cannot drift. */
export const skuMatrixBody = z.object({
  specs: z.array(productSpecInput).min(1).max(5),
});

export const skuMatrixResult = z.object({
  rows: z.array(
    z.object({
      specValues: z.record(z.string(), z.string()),
      specText: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// products — admin
// ---------------------------------------------------------------------------

export const adminProductListItem = z.object({
  id,
  name: z.string(),
  subtitle: z.string().nullable(),
  spu: z.string().nullable(),
  kind: productKind,
  status: productStatus,
  imageUrl: z.string(),
  price: money,
  originalPrice: money.nullable(),
  cost: money.nullable(),
  /** Sum of live SKU stock. The authoritative number is per SKU. */
  stock: z.number().int().min(0),
  sales: z.number().int().min(0),
  displaySalesBoost: z.number().int().min(0),
  views: z.number().int().min(0),
  specMode: z.boolean(),
  isHot: z.boolean(),
  isNew: z.boolean(),
  isBest: z.boolean(),
  isBenefit: z.boolean(),
  isRecommended: z.boolean(),
  sortOrder: z.number().int(),
  categoryIds: z.array(id),
  categoryNames: z.array(z.string()),
  labels: z.array(productCardLabel),
  createdAt: instant,
  updatedAt: instant,
  /** Non-null only in the recycle-bin tab. */
  deletedAt: instant.nullable(),
});
export type AdminProductListItem = z.infer<typeof adminProductListItem>;

export const adminProductDetail = adminProductListItem.extend({
  keyword: z.string().nullable(),
  barCode: z.string().nullable(),
  cardImageUrl: z.string().nullable(),
  sliderImages: z.array(z.string()),
  videoUrl: z.string().nullable(),
  unitName: z.string().nullable(),
  freightMode: productFreightMode,
  fixedFreight: money.nullable(),
  shippingTemplateId: id.nullable(),
  purchaseLimitMode: productPurchaseLimitMode,
  purchaseLimitQuantity: z.number().int().nullable(),
  minPurchaseQuantity: z.number().int().min(1),
  customForm: z.array(productCustomFormField).nullable(),
  descriptionHtml: z.string(),
  specs: z.array(productSpec),
  skus: z.array(productSku),
  params: z.array(z.object({ id, name: z.string(), value: z.string(), templateId: id.nullable() })),
  protectionIds: z.array(id),
  labelIds: z.array(id),
  recommendedProductIds: z.array(id),
  /** "Buy this, get that coupon." */
  giftCouponIds: z.array(id),
});
export type AdminProductDetail = z.infer<typeof adminProductDetail>;

/**
 * Create / update body.
 *
 * The refinements mirror the table CHECKs (`products_freight_source`,
 * `products_limit_quantity`) and the SKU rules, so an impossible product is a
 * 422 with a field error rather than a 500 from a constraint violation. The
 * same schema runs in the browser through `ZodForm`.
 */
export const adminProductForm = z
  .object({
    name: z.string().trim().min(1).max(128),
    subtitle: z.string().trim().max(255).optional(),
    keyword: z.string().trim().max(255).optional(),
    spu: z.string().trim().max(32).optional(),
    barCode: z.string().trim().max(32).optional(),
    kind: productKind.default('physical'),
    status: productStatus.default('draft'),
    imageUrl: z.string().min(1).max(512),
    cardImageUrl: z.string().max(512).optional(),
    sliderImages: z.array(z.string().max(512)).max(10).default([]),
    videoUrl: z.string().max(512).optional(),
    unitName: z.string().trim().max(32).optional(),
    originalPrice: money.optional(),
    displaySalesBoost: z.number().int().min(0).max(1_000_000).default(0),
    /** `false` means one implicit SKU; `true` means the spec matrix below. */
    specMode: z.boolean().default(false),
    specs: z.array(productSpecInput).max(5).default([]),
    skus: z.array(productSkuInput).min(1).max(500),
    freightMode: productFreightMode.default('template'),
    fixedFreight: money.optional(),
    shippingTemplateId: id.optional(),
    purchaseLimitMode: productPurchaseLimitMode.default('none'),
    purchaseLimitQuantity: z.number().int().min(1).max(100_000).optional(),
    minPurchaseQuantity: z.number().int().min(1).max(100_000).default(1),
    isHot: z.boolean().default(false),
    isNew: z.boolean().default(false),
    isBest: z.boolean().default(false),
    isBenefit: z.boolean().default(false),
    isRecommended: z.boolean().default(false),
    customForm: z.array(productCustomFormField).max(20).optional(),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    descriptionHtml: z.string().max(500_000).default(''),
    categoryIds: z.array(id).min(1).max(20),
    labelIds: z.array(id).max(20).default([]),
    protectionIds: z.array(id).max(20).default([]),
    params: z.array(productParam).max(50).default([]),
    recommendedProductIds: z.array(id).max(20).default([]),
    giftCouponIds: z.array(id).max(10).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.freightMode === 'fixed' && value.fixedFreight === undefined) {
      ctx.addIssue({ code: 'custom', path: ['fixedFreight'], message: '请填写固定运费' });
    }
    if (value.freightMode === 'template' && value.shippingTemplateId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['shippingTemplateId'], message: '请选择运费模板' });
    }
    if (value.freightMode !== 'fixed' && value.fixedFreight !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['fixedFreight'],
        message: '当前计费方式不需要固定运费',
      });
    }
    if (value.freightMode !== 'template' && value.shippingTemplateId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['shippingTemplateId'],
        message: '当前计费方式不需要运费模板',
      });
    }

    if (value.purchaseLimitMode === 'none') {
      if (value.purchaseLimitQuantity !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['purchaseLimitQuantity'],
          message: '不限购时不需要填写限购数量',
        });
      }
    } else if (value.purchaseLimitQuantity === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['purchaseLimitQuantity'],
        message: '请填写限购数量',
      });
    } else if (value.minPurchaseQuantity > value.purchaseLimitQuantity) {
      // 起购 3、限购 2 is a product nobody can buy.
      ctx.addIssue({
        code: 'custom',
        path: ['minPurchaseQuantity'],
        message: '起购数量不能大于限购数量',
      });
    }

    if (value.specMode) {
      if (value.specs.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['specs'], message: '多规格商品至少要有一组规格' });
      }
      const axes = value.specs.map((s) => s.name);
      if (new Set(axes).size !== axes.length) {
        ctx.addIssue({ code: 'custom', path: ['specs'], message: '规格名称不能重复' });
      }
      for (const [index, sku] of value.skus.entries()) {
        for (const axis of axes) {
          if (sku.specValues[axis] === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['skus', index, 'specValues'],
              message: `规格组合缺少「${axis}」`,
            });
          }
        }
      }
    } else {
      if (value.specs.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['specs'], message: '单规格商品不需要规格组' });
      }
      if (value.skus.length !== 1) {
        ctx.addIssue({ code: 'custom', path: ['skus'], message: '单规格商品只能有一条库存记录' });
      }
    }

    const combos = value.skus.map((sku) =>
      Object.keys(sku.specValues)
        .sort()
        .map((k) => `${k}=${sku.specValues[k]}`)
        .join('|'),
    );
    if (new Set(combos).size !== combos.length) {
      ctx.addIssue({ code: 'custom', path: ['skus'], message: '规格组合不能重复' });
    }
    if (value.skus.filter((sku) => sku.isDefault).length > 1) {
      ctx.addIssue({ code: 'custom', path: ['skus'], message: '只能有一个默认规格' });
    }

    // A card-key product's stock is the card pool, not a number an operator
    // types: kept apart, the two drift and the shop sells cards that do not
    // exist. The editor echoes the pool it was shown (`stock` equal to
    // `expectedStock`), which is not typing a number, and the server derives
    // the stock from the pool either way.
    if (
      value.kind === 'virtual_card' &&
      value.skus.some((sku) => sku.stock > 0 && sku.stock !== sku.expectedStock)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['skus'],
        message: '卡密商品的库存由导入的卡密数量决定，请勿手动填写',
      });
    }
    if (value.kind !== 'physical' && value.freightMode !== 'free') {
      ctx.addIssue({ code: 'custom', path: ['freightMode'], message: '虚拟商品不计算运费' });
    }
  });
export type AdminProductForm = z.infer<typeof adminProductForm>;

/**
 * The 商品列表 tabs, as one key rather than a `type` integer.
 *
 * `sold_out` and `stock_warning` are *derived* (stock = 0, stock below the
 * configured threshold) rather than stored, which is why they are here and not
 * in `status`.
 */
export const adminProductTab = z.enum([
  'all',
  'on_shelf',
  'off_shelf',
  'draft',
  'sold_out',
  'stock_warning',
  'deleted',
]);
export type AdminProductTab = z.infer<typeof adminProductTab>;

export const adminProductListQuery = pageQuery
  .extend({
    tab: adminProductTab.default('all'),
    keyword: z.string().trim().max(64).optional(),
    categoryId: id.optional(),
    labelId: id.optional(),
    /**
     * Exactly these products, in this order: how the DIY editor turns the ids
     * a saved page stores back into rows. The tab still applies, so under the
     * default `all` a deleted product is simply absent. The order is the
     * list's, so `sortBy` does not apply.
     */
    ids: idList.optional(),
    kind: productKind.optional(),
    priceFrom: money.optional(),
    priceTo: money.optional(),
  })
  .extend(sortQuery(['id', 'price', 'stock', 'sales', 'sortOrder', 'createdAt']).shape);
export type AdminProductListQuery = z.infer<typeof adminProductListQuery>;

export const pagedAdminProducts = paged(adminProductListItem);

export const adminProductStatusBody = z.object({
  status: z.enum(['on_shelf', 'off_shelf']),
});

/** One row of the 库存预警 list; one per SKU, not per product. */
export const stockWarningItem = z.object({
  productId: id,
  productName: z.string(),
  imageUrl: z.string(),
  status: productStatus,
  skuId: id,
  specText: z.string(),
  skuCode: z.string(),
  stock: z.number().int().min(0),
  /** The configured `catalog.stockWarningThreshold` this row fell under. */
  threshold: z.number().int().min(0),
});
export type StockWarningItem = z.infer<typeof stockWarningItem>;

export const stockWarningListQuery = pageQuery.extend({
  keyword: z.string().trim().max(64).optional(),
  categoryId: id.optional(),
  /** Overrides the configured threshold for this call only. */
  threshold: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export const pagedStockWarnings = paged(stockWarningItem);

/**
 * The export payload.
 *
 * `handle()` serialises every response as JSON, so the rows travel as JSON and
 * the admin page turns them into a CSV/XLSX download in the browser. That keeps
 * one response pipeline (validation, audit, error mapping) instead of a second,
 * unvalidated one for file streams.
 */
export const productExportQuery = z.object({
  tab: adminProductTab.default('all'),
  keyword: z.string().trim().max(64).optional(),
  categoryId: id.optional(),
  kind: productKind.optional(),
  /** Hard ceiling; the server refuses more and asks for a narrower filter. */
  limit: z.coerce.number().int().min(1).max(10_000).default(2000),
});

export const productExportResult = z.object({
  filename: z.string(),
  columns: z.array(z.object({ key: z.string(), title: z.string() })),
  /** Every value already a string, so the browser writes the CSV without formatting decisions. */
  rows: z.array(z.record(z.string(), z.string())),
  total: z.number().int().min(0),
  /** True when `total` exceeded `limit` and the rows are the first page of it. */
  truncated: z.boolean(),
});
export type ProductExportResult = z.infer<typeof productExportResult>;

// ---------------------------------------------------------------------------
// virtual card inventory
// ---------------------------------------------------------------------------

export const productVirtualCard = z.object({
  id,
  skuId: id,
  specText: z.string(),
  /** The opaque handle shown to the buyer. */
  cardKey: z.string(),
  cardNo: z.string(),
  cardSecret: z.string().nullable(),
  state: productVirtualCardState,
  orderItemId: id.nullable(),
  claimedByUserId: id.nullable(),
  claimedAt: instant.nullable(),
  createdAt: instant,
});
export type ProductVirtualCard = z.infer<typeof productVirtualCard>;

export const virtualCardImportBody = z.object({
  skuId: id,
  cards: z
    .array(
      z.object({
        cardNo: z.string().trim().min(1).max(255),
        cardSecret: z.string().max(255).optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export type VirtualCardImportBody = z.infer<typeof virtualCardImportBody>;

export const virtualCardImportResult = z.object({
  imported: z.number().int().min(0),
  /** Card numbers already in this SKU's pool; nothing is imported twice. */
  skippedCardNos: z.array(z.string()),
  /** The SKU's stock after the import — the card pool *is* the stock. */
  stock: z.number().int().min(0),
});

export const virtualCardListQuery = pageQuery.extend({
  skuId: id.optional(),
  state: productVirtualCardState.optional(),
});

export const pagedVirtualCards = paged(productVirtualCard);

export const virtualCardVoidBody = z.object({
  cardIds: z.array(id).min(1).max(200),
});

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

export const adminProductReview = z.object({
  id,
  productId: id,
  productName: z.string(),
  productImageUrl: z.string(),
  skuId: id.nullable(),
  specText: z.string().nullable(),
  userId: id.nullable(),
  orderId: id.nullable(),
  orderItemId: id.nullable(),
  authorNickname: z.string().nullable(),
  authorAvatarUrl: z.string().nullable(),
  productScore: z.number().int().min(1).max(5),
  serviceScore: z.number().int().min(1).max(5),
  content: z.string().nullable(),
  images: z.array(z.string()),
  status: productReviewStatus,
  /**
   * Why it waits in 待审核, when the reason is WeChat's 内容安全 (C09):
   * `sec_check_risky`, `sec_check_review`, `sec_check_unavailable`,
   * `sec_check_unchecked`, `sec_check_image_unchecked`; else `null`.
   */
  moderationReason: z.string().nullable(),
  replyContent: z.string().nullable(),
  replyAt: instant.nullable(),
  createdAt: instant,
});
export type AdminProductReview = z.infer<typeof adminProductReview>;

/** What a shopper sees. No `status` (every visible one is published), no user id. */
export const productReview = z.object({
  id,
  skuId: id.nullable(),
  specText: z.string().nullable(),
  authorNickname: z.string().nullable(),
  authorAvatarUrl: z.string().nullable(),
  productScore: z.number().int().min(1).max(5),
  serviceScore: z.number().int().min(1).max(5),
  content: z.string().nullable(),
  images: z.array(z.string()),
  replyContent: z.string().nullable(),
  replyAt: instant.nullable(),
  createdAt: instant,
});
export type ProductReview = z.infer<typeof productReview>;

/**
 * What `POST /catalog/reviews` answers: the review, and whether it is live.
 * `pending` is neutral on purpose — the client says 「评价已提交，审核后展示」,
 * whether the reason is 评价需审核 or 内容安全, and never shows it as an error.
 */
export const submittedReview = productReview.extend({
  moderation: z.enum(['published', 'pending']),
});
export type SubmittedReview = z.infer<typeof submittedReview>;

export const adminReviewListQuery = pageQuery
  .extend({
    keyword: z.string().trim().max(64).optional(),
    productId: id.optional(),
    status: z.union([productReviewStatus, z.array(productReviewStatus)]).optional(),
    /** 好评 4–5 / 中评 3 / 差评 1–2. */
    rating: z.enum(['good', 'medium', 'bad']).optional(),
    hasReply: z.stringbool().optional(),
    hasImages: z.stringbool().optional(),
  })
  .extend(sortQuery(['id', 'productScore', 'createdAt']).shape);
export type AdminReviewListQuery = z.infer<typeof adminReviewListQuery>;

export const pagedAdminReviews = paged(adminProductReview);

/** 虚拟评论: an admin writes a review nobody bought. `orderItemId` stays null. */
export const adminReviewForm = z
  .object({
    productId: id,
    skuId: id.optional(),
    authorNickname: z.string().trim().min(1).max(64),
    authorAvatarUrl: z.string().max(512).optional(),
    productScore: z.number().int().min(1).max(5),
    serviceScore: z.number().int().min(1).max(5),
    content: z.string().max(1000).optional(),
    images: z.array(z.string().max(512)).max(9).default([]),
    /** Backdating is allowed — a seeded review dated today fools nobody. */
    createdAt: instant.optional(),
  })
  .strict();
export type AdminReviewForm = z.infer<typeof adminReviewForm>;

export const reviewReplyBody = z.object({
  content: z.string().trim().min(1).max(500),
});

export const reviewStatusBody = z.object({
  status: productReviewStatus,
});

export const reviewBatchStatusBody = z.object({
  reviewIds: z.array(id).min(1).max(200),
  status: productReviewStatus,
});

export const reviewBatchStatusResult = z.object({
  /** Rows the one conditional update actually moved; ids already in the target state are not counted. */
  updated: z.number().int().min(0),
});

/** What a shopper posts after receiving the goods. One per order line. */
export const reviewSubmitBody = z
  .object({
    orderItemId: id,
    productScore: z.number().int().min(1).max(5),
    serviceScore: z.number().int().min(1).max(5),
    content: z.string().max(1000).optional(),
    images: z.array(z.string().max(512)).max(9).default([]),
  })
  .strict();
export type ReviewSubmitBody = z.infer<typeof reviewSubmitBody>;

/** The 评价 header on a product page. */
export const reviewSummary = z.object({
  total: z.number().int().min(0),
  goodCount: z.number().int().min(0),
  mediumCount: z.number().int().min(0),
  badCount: z.number().int().min(0),
  withImagesCount: z.number().int().min(0),
  /** Mean product score, one decimal. `0` when there are no reviews. */
  averageScore: z.number().min(0).max(5),
  /** Whole percent of 好评. `100` when there are no reviews. */
  goodRate: z.number().int().min(0).max(100),
});
export type ReviewSummary = z.infer<typeof reviewSummary>;

export const reviewListQuery = pageQuery.extend({
  rating: z.enum(['all', 'good', 'medium', 'bad', 'images']).default('all'),
});

export const pagedReviews = paged(productReview);

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

/**
 * **The shared product card.** DIY, marketing, cart and search all render this
 * one shape; add a field here rather than inventing a parallel DTO.
 *
 * `salesDisplay` is `sales + displaySalesBoost`, already added up — nothing
 * downstream should have to know the padding exists. `canAddToCart` is decided
 * on the server: a card/coupon/manual product, or one with a custom form, is
 * bought straight away rather than added to a cart.
 */
export const productCard = z.object({
  id,
  name: z.string(),
  subtitle: z.string().nullable(),
  imageUrl: z.string(),
  cardImageUrl: z.string().nullable(),
  price: money,
  originalPrice: money.nullable(),
  stock: z.number().int().min(0),
  salesDisplay: z.number().int().min(0),
  unitName: z.string().nullable(),
  kind: productKind,
  labels: z.array(productCardLabel),
  canAddToCart: z.boolean(),
});
export type ProductCard = z.infer<typeof productCard>;

/** The SKU as a shopper sees it: no cost, no sales, no invisible rows. */
export const storefrontSku = z.object({
  id,
  skuCode: z.string(),
  specText: z.string(),
  specValues: z.record(z.string(), z.string()),
  imageUrl: z.string().nullable(),
  price: money,
  originalPrice: money.nullable(),
  stock: z.number().int().min(0),
  weight: weight.nullable(),
  volume: volume.nullable(),
});
export type StorefrontSku = z.infer<typeof storefrontSku>;

export const storefrontSpec = z.object({
  name: z.string(),
  values: z.array(z.object({ value: z.string(), imageUrl: z.string().nullable() })),
});

export const storefrontProduct = productCard.extend({
  sliderImages: z.array(z.string()),
  videoUrl: z.string().nullable(),
  specMode: z.boolean(),
  minPurchaseQuantity: z.number().int().min(1),
  purchaseLimitMode: productPurchaseLimitMode,
  purchaseLimitQuantity: z.number().int().nullable(),
  freightMode: productFreightMode,
  fixedFreight: money.nullable(),
  views: z.number().int().min(0),
  descriptionHtml: z.string(),
  specs: z.array(storefrontSpec),
  skus: z.array(storefrontSku),
  params: z.array(z.object({ name: z.string(), value: z.string() })),
  protections: z.array(
    z.object({
      id,
      title: z.string(),
      content: z.string().nullable(),
      iconUrl: z.string().nullable(),
    }),
  ),
  customForm: z.array(productCustomFormField).nullable(),
  /** `null` for an anonymous visitor: "not favourited" and "we do not know you" differ. */
  favorited: z.boolean().nullable(),
  reviewSummary,
  /** Coupon templates this purchase hands out. The coupon domain renders them. */
  giftCouponIds: z.array(id),
});
export type StorefrontProduct = z.infer<typeof storefrontProduct>;

/** The SKU matrix on its own, for the cart popup. */
export const productSkuMatrix = z.object({
  productId: id,
  specMode: z.boolean(),
  specs: z.array(storefrontSpec),
  skus: z.array(storefrontSku),
});

export const storefrontProductListQuery = pageQuery
  .extend({
    keyword: z.string().trim().max(64).optional(),
    categoryId: id.optional(),
    labelId: id.optional(),
    /**
     * Exactly these products, in this order — what a DIY component's
     * 指定商品 saved. An id that is off the shelf or deleted is skipped, not
     * an error: the page was built before the product went away. The order is
     * the list's, so `sortBy` does not apply.
     */
    ids: idList.optional(),
    /** Products in any of these categories — a DIY component's 指定分类. */
    categoryIds: idList.optional(),
    /** Products carrying any of these labels — a DIY component's 商品标签. */
    labelIds: idList.optional(),
    priceFrom: money.optional(),
    priceTo: money.optional(),
    /** The 精品/热卖/最新/促销 flags, as one key. */
    feature: z.enum(['hot', 'new', 'best', 'benefit', 'recommended']).optional(),
    /**
     * Only the products this coupon **template** covers (`userCoupon.templateId`,
     * `claimableCoupon.templateId`) — 我的优惠券「去使用」. Shop-wide: every product;
     * 指定商品: those; 品类券: the products filed under its categories. The scope the
     * checkout applies. An unknown template, or a draft, lists nothing.
     */
    couponId: id.optional(),
  })
  .extend(sortQuery(['price', 'sales', 'createdAt']).shape);
export type StorefrontProductListQuery = z.infer<typeof storefrontProductListQuery>;

export const pagedProductCards = paged(productCard);

/** The storefront category tree; only visible categories, only live products counted. */
export const storefrontCategory = z.object({
  id,
  name: z.string(),
  iconUrl: z.string().nullable(),
  bannerUrl: z.string().nullable(),
});

export const storefrontCategoryNode = storefrontCategory.extend({
  children: z.array(storefrontCategory.extend({ children: z.array(storefrontCategory) })),
});

export const storefrontCategoryTree = z.object({
  items: z.array(storefrontCategoryNode),
  /**
   * Changes whenever any visible category does. A client may cache the tree
   * and only refetch when this moves.
   */
  version: z.string(),
});

// ---------------------------------------------------------------------------
// favourites, history, search
// ---------------------------------------------------------------------------

export const favoriteItem = z.object({
  product: productCard,
  /**
   * Still for sale: on the shelf and not deleted. A product taken off sale stays
   * on the list (so the shopper can see and remove it) with this `false`, and
   * the storefront draws it 已下架 instead of an ordinary sold-out card.
   */
  available: z.boolean(),
  createdAt: instant,
});
export type FavoriteItem = z.infer<typeof favoriteItem>;

export const pagedFavorites = paged(favoriteItem);

export const favoriteAddBody = z.object({ productId: id });

/**
 * 批量收藏 — the 我的收藏 screen's bulk button, in one request so it cannot
 * half-succeed the way one request per product could.
 *
 * Capped at 50: it is a screenful of tick boxes, not an import.
 */
export const favoriteAddBatchBody = z.object({
  productIds: z.array(id).min(1).max(50),
});
export type FavoriteAddBatchBody = z.infer<typeof favoriteAddBatchBody>;

/**
 * What the batch managed to do.
 *
 * Reports rather than refuses, for the same reason 再次购买 does: a product
 * going off shelf between the list and the button is the normal case, and
 * failing the other 49 over it would be worse than saying so. `favorited` is
 * the **resulting state** of each id, so a product that was already favourited
 * reads `true` — the call is idempotent and the storefront can paint the hearts
 * straight from the answer.
 */
export const favoriteAddBatchResult = z.object({
  /** Rows this call actually inserted. Zero on a replay. */
  added: z.number().int().min(0),
  items: z.array(z.object({ productId: id, favorited: z.boolean() })),
});
export type FavoriteAddBatchResult = z.infer<typeof favoriteAddBatchResult>;

export const favoriteRemoveBody = z.object({
  productIds: z.array(id).min(1).max(100),
});

export const favoriteRemoveResult = z.object({
  removed: z.number().int().min(0),
});

/**
 * One browsed product.
 *
 * Browse history is derived from `product_events` with `kind = 'view'`, grouped
 * by product and day — the same rows the operator dashboard counts, so a view
 * is recorded once and read twice rather than written to two tables.
 */
export const historyItem = z.object({
  product: productCard,
  /** See `favoriteItem.available`. */
  available: z.boolean(),
  viewedAt: instant,
});
export type HistoryItem = z.infer<typeof historyItem>;

export const pagedHistory = paged(historyItem);

export const hotKeyword = z.object({
  keyword: z.string(),
  count: z.number().int().min(1),
});

export const hotKeywordsResult = z.object({ items: z.array(hotKeyword) });

export const searchHistoryResult = z.object({
  items: z.array(z.object({ keyword: z.string(), searchedAt: instant })),
});

// ---------------------------------------------------------------------------
// examples
// ---------------------------------------------------------------------------

/**
 * One consistent fixture reused by every example, so the mock server tells the
 * mini program and the admin a coherent story: product 1 is 「经典白T恤」, it has
 * two SKUs, it sits in category 7 and it carries label 3.
 */
export const productCategoryExample: ProductCategory = {
  id: '7',
  parentId: null,
  name: '男装',
  path: '/',
  level: 0,
  iconUrl: 'https://cdn.example.com/cate/men.png',
  bannerUrl: null,
  sortOrder: 10,
  isVisible: true,
  productCount: 24,
  createdAt: '2026-01-01T10:00:00+08:00',
};

export const productCategoryChildExample: ProductCategory = {
  ...productCategoryExample,
  id: '17',
  parentId: '7',
  name: 'T恤',
  path: '/7/',
  level: 1,
  iconUrl: null,
  sortOrder: 20,
  productCount: 9,
};

export const productCategoryNodeExample: ProductCategoryNode = {
  ...productCategoryExample,
  children: [{ ...productCategoryChildExample, children: [] }],
};

export const productCardLabelExample: ProductCardLabel = {
  id: '3',
  name: '包邮',
  style: 'text',
  fontColor: '#FFFFFF',
  backgroundColor: '#E93323',
  borderColor: null,
  imageUrl: null,
};

export const productLabelExample: ProductLabel = {
  ...productCardLabelExample,
  categoryId: '1',
  categoryName: '促销',
  isVisible: true,
  isEnabled: true,
  sortOrder: 0,
  productCount: 12,
  createdAt: '2026-01-01T10:00:00+08:00',
};

export const productLabelCategoryExample: ProductLabelCategory = {
  id: '1',
  name: '促销',
  sortOrder: 0,
  labelCount: 4,
  createdAt: '2026-01-01T10:00:00+08:00',
};

export const productParamTemplateExample: ProductParamTemplate = {
  id: '1',
  name: '面料',
  suggestedValues: '纯棉\n涤纶\n亚麻',
  isEnabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T10:00:00+08:00',
};

export const productProtectionExample: ProductProtection = {
  id: '1',
  title: '七天无理由退换',
  content: '自签收之日起 7 天内，商品保持完好可申请退换。',
  iconUrl: null,
  isEnabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T10:00:00+08:00',
};

export const productSkuExample: ProductSku = {
  id: '1001',
  skuCode: 'SKU7K3M9QX2',
  specText: '白|M',
  specValues: { 颜色: '白', 尺码: 'M' },
  imageUrl: 'https://cdn.example.com/p/1-white.png',
  price: '59.00',
  originalPrice: '99.00',
  cost: '22.00',
  stock: 120,
  sales: 33,
  barCode: null,
  weight: '0.250',
  volume: null,
  isDefault: true,
  isVisible: true,
  sortOrder: 0,
};

export const productSkuSecondExample: ProductSku = {
  ...productSkuExample,
  id: '1002',
  skuCode: 'SKU7K3M9QX3',
  specText: '白|L',
  specValues: { 颜色: '白', 尺码: 'L' },
  stock: 4,
  sales: 8,
  isDefault: false,
};

export const productSpecExample: ProductSpec = {
  id: '201',
  name: '颜色',
  sortOrder: 0,
  values: [
    { id: '301', value: '白', imageUrl: 'https://cdn.example.com/p/1-white.png', sortOrder: 0 },
  ],
};

export const productSpecSizeExample: ProductSpec = {
  id: '202',
  name: '尺码',
  sortOrder: 1,
  values: [
    { id: '302', value: 'M', imageUrl: null, sortOrder: 0 },
    { id: '303', value: 'L', imageUrl: null, sortOrder: 1 },
  ],
};

export const adminProductListItemExample: AdminProductListItem = {
  id: '1',
  name: '经典白T恤',
  subtitle: '100% 新疆长绒棉',
  spu: 'TS-0001',
  kind: 'physical',
  status: 'on_shelf',
  imageUrl: 'https://cdn.example.com/p/1.png',
  price: '59.00',
  originalPrice: '99.00',
  cost: '22.00',
  stock: 124,
  sales: 41,
  displaySalesBoost: 100,
  views: 3820,
  specMode: true,
  isHot: true,
  isNew: false,
  isBest: false,
  isBenefit: false,
  isRecommended: true,
  sortOrder: 0,
  categoryIds: ['7', '17'],
  categoryNames: ['男装', 'T恤'],
  labels: [productCardLabelExample],
  createdAt: '2026-01-02T09:00:00+08:00',
  updatedAt: '2026-03-04T15:20:00+08:00',
  deletedAt: null,
};

export const adminProductDetailExample: AdminProductDetail = {
  ...adminProductListItemExample,
  keyword: '白T恤 短袖 纯棉',
  barCode: null,
  cardImageUrl: null,
  sliderImages: ['https://cdn.example.com/p/1.png', 'https://cdn.example.com/p/1-back.png'],
  videoUrl: null,
  unitName: '件',
  freightMode: 'template',
  fixedFreight: null,
  shippingTemplateId: '1',
  purchaseLimitMode: 'per_order',
  purchaseLimitQuantity: 5,
  minPurchaseQuantity: 1,
  customForm: null,
  descriptionHtml: '<p>经典款，四季可穿。</p>',
  specs: [productSpecExample, productSpecSizeExample],
  skus: [productSkuExample, productSkuSecondExample],
  params: [{ id: '401', name: '面料', value: '纯棉', templateId: '1' }],
  protectionIds: ['1'],
  labelIds: ['3'],
  recommendedProductIds: [],
  giftCouponIds: ['1'],
};

export const adminProductFormExample = {
  name: '经典白T恤',
  subtitle: '100% 新疆长绒棉',
  keyword: '白T恤 短袖 纯棉',
  spu: 'TS-0001',
  kind: 'physical',
  status: 'on_shelf',
  imageUrl: 'https://cdn.example.com/p/1.png',
  sliderImages: ['https://cdn.example.com/p/1.png', 'https://cdn.example.com/p/1-back.png'],
  unitName: '件',
  originalPrice: '99.00',
  displaySalesBoost: 100,
  specMode: true,
  specs: [
    { name: '颜色', values: [{ value: '白', imageUrl: 'https://cdn.example.com/p/1-white.png' }] },
    { name: '尺码', values: [{ value: 'M' }, { value: 'L' }] },
  ],
  skus: [
    {
      specValues: { 颜色: '白', 尺码: 'M' },
      price: '59.00',
      originalPrice: '99.00',
      cost: '22.00',
      stock: 120,
      weight: '0.250',
      isDefault: true,
    },
    {
      specValues: { 颜色: '白', 尺码: 'L' },
      price: '59.00',
      originalPrice: '99.00',
      cost: '22.00',
      stock: 4,
      weight: '0.260',
    },
  ],
  freightMode: 'template',
  shippingTemplateId: '1',
  purchaseLimitMode: 'per_order',
  purchaseLimitQuantity: 5,
  isHot: true,
  isRecommended: true,
  descriptionHtml: '<p>经典款，四季可穿。</p>',
  categoryIds: ['7', '17'],
  labelIds: ['3'],
  protectionIds: ['1'],
  params: [{ name: '面料', value: '纯棉', templateId: '1' }],
  giftCouponIds: ['1'],
} as const;

export const reviewSummaryExample: ReviewSummary = {
  total: 18,
  goodCount: 16,
  mediumCount: 1,
  badCount: 1,
  withImagesCount: 7,
  averageScore: 4.6,
  goodRate: 89,
};

export const productCardExample: ProductCard = {
  id: '1',
  name: '经典白T恤',
  subtitle: '100% 新疆长绒棉',
  imageUrl: 'https://cdn.example.com/p/1.png',
  cardImageUrl: null,
  price: '59.00',
  originalPrice: '99.00',
  stock: 124,
  salesDisplay: 141,
  unitName: '件',
  kind: 'physical',
  labels: [productCardLabelExample],
  canAddToCart: true,
};

export const storefrontSkuExample: StorefrontSku = {
  id: '1001',
  skuCode: 'SKU7K3M9QX2',
  specText: '白|M',
  specValues: { 颜色: '白', 尺码: 'M' },
  imageUrl: 'https://cdn.example.com/p/1-white.png',
  price: '59.00',
  originalPrice: '99.00',
  stock: 120,
  weight: '0.250',
  volume: null,
};

export const storefrontProductExample: StorefrontProduct = {
  ...productCardExample,
  sliderImages: ['https://cdn.example.com/p/1.png', 'https://cdn.example.com/p/1-back.png'],
  videoUrl: null,
  specMode: true,
  minPurchaseQuantity: 1,
  purchaseLimitMode: 'per_order',
  purchaseLimitQuantity: 5,
  freightMode: 'template',
  fixedFreight: null,
  views: 3820,
  descriptionHtml: '<p>经典款，四季可穿。</p>',
  specs: [
    { name: '颜色', values: [{ value: '白', imageUrl: 'https://cdn.example.com/p/1-white.png' }] },
    {
      name: '尺码',
      values: [
        { value: 'M', imageUrl: null },
        { value: 'L', imageUrl: null },
      ],
    },
  ],
  skus: [
    storefrontSkuExample,
    {
      ...storefrontSkuExample,
      id: '1002',
      skuCode: 'SKU7K3M9QX3',
      specText: '白|L',
      specValues: { 颜色: '白', 尺码: 'L' },
      stock: 4,
    },
  ],
  params: [{ name: '面料', value: '纯棉' }],
  protections: [
    {
      id: '1',
      title: '七天无理由退换',
      content: '自签收之日起 7 天内，商品保持完好可申请退换。',
      iconUrl: null,
    },
  ],
  customForm: null,
  favorited: false,
  reviewSummary: reviewSummaryExample,
  giftCouponIds: ['1'],
};

export const productReviewExample: ProductReview = {
  id: '5001',
  skuId: '1001',
  specText: '白|M',
  authorNickname: '小明',
  authorAvatarUrl: 'https://cdn.example.com/u/101.png',
  productScore: 5,
  serviceScore: 5,
  content: '料子很舒服，洗了不变形。',
  images: ['https://cdn.example.com/r/5001-1.png'],
  replyContent: '感谢支持！',
  replyAt: '2026-03-02T10:00:00+08:00',
  createdAt: '2026-03-01T20:11:00+08:00',
};

export const adminProductReviewExample: AdminProductReview = {
  ...productReviewExample,
  productId: '1',
  productName: '经典白T恤',
  productImageUrl: 'https://cdn.example.com/p/1.png',
  userId: '101',
  orderId: '9001',
  orderItemId: '9101',
  status: 'published',
  moderationReason: null,
};

export const productVirtualCardExample: ProductVirtualCard = {
  id: '7001',
  skuId: '1001',
  specText: '白|M',
  cardKey: 'CK5F2A7B9C1D',
  cardNo: '8800-1234-5678',
  cardSecret: '9f3a1c',
  state: 'unclaimed',
  orderItemId: null,
  claimedByUserId: null,
  claimedAt: null,
  createdAt: '2026-02-01T09:00:00+08:00',
};

export const stockWarningItemExample: StockWarningItem = {
  productId: '1',
  productName: '经典白T恤',
  imageUrl: 'https://cdn.example.com/p/1.png',
  status: 'on_shelf',
  skuId: '1002',
  specText: '白|L',
  skuCode: 'SKU7K3M9QX3',
  stock: 4,
  threshold: 10,
};
