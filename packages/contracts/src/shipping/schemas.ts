import { z } from 'zod';
import { id, instant, money, pageQuery, paged, sortQuery } from '../_conventions/common';

/**
 * Shipping shapes: freight templates, the city tree and courier companies.
 *
 * Two conventions worth stating once, because they run through every shape
 * here:
 *
 * - **Prices are `money` strings, thresholds are plain numbers.** `firstUnit`,
 *   `additionalUnit` and `minUnits` are *measurements* — pieces, kilograms or
 *   cubic metres — not money, so they travel as numbers with at most two
 *   fraction digits (which is what `numeric(12,2)` stores). Everything with a
 *   ¥ in front of it stays a string, all the way down to `Money`.
 * - **A rule with no cities is the fallback rule**: `cityIds: []` on the one
 *   rule whose `isFallback` is true, not a magic city id. The database has a
 *   partial unique index enforcing at most one such rule per template.
 */

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

/** Mirrors the `shipping_templates_charge_mode` PostgreSQL enum. */
export const shippingChargeMode = z.enum(['quantity', 'weight', 'volume']);
export type ShippingChargeMode = z.infer<typeof shippingChargeMode>;

/**
 * A measurement stored as `numeric(12,2)`. Two fraction digits, never
 * negative, and small enough that a double represents it exactly.
 *
 * Checked by rounding to two places and comparing, not by `value * 100` being
 * whole: 1.1 × 100 is 110.00000000000001 in binary floating point, so that
 * test refused 1.1 kg, 2.3 kg and 0.29 m³.
 */
export const unitAmount = z
  .number()
  .min(0)
  .max(9_999_999_999)
  .refine((value) => Number.isFinite(value) && Number(value.toFixed(2)) === value, {
    message: '最多两位小数',
  });

// ---------------------------------------------------------------------------
// cities
// ---------------------------------------------------------------------------

const cityBase = z.object({
  id,
  name: z.string(),
  /** 0 = province / municipality, 1 = city, 2 = district or county. */
  level: z.number().int().min(0).max(3),
});

/**
 * Three levels, written out rather than recursed.
 *
 * `z.lazy` is legal zod but produces a `$ref` cycle that `zod-to-openapi`
 * cannot render, and the administrative tree has been exactly three levels
 * since it was seeded. The catalog's category tree is written out for the same
 * reason.
 */
const cityDistrict = cityBase;
const cityCity = cityBase.extend({ children: z.array(cityDistrict) });
export const cityProvince = cityBase.extend({ children: z.array(cityCity) });
export type CityProvince = z.infer<typeof cityProvince>;

export const cityTree = z.object({
  items: z.array(cityProvince),
  /**
   * Fingerprint of the seeded tree, also served as the `ETag`. The data is
   * immutable, so a client that has seen this value never needs the body again
   * — which is why there is no route to clear a cache.
   */
  version: z.string(),
});
export type CityTree = z.infer<typeof cityTree>;

export const cityTreeExample: CityTree = {
  items: [
    {
      id: '110000',
      name: '北京',
      level: 0,
      children: [
        {
          id: '110100',
          name: '北京市',
          level: 1,
          children: [
            { id: '110101', name: '东城区', level: 2 },
            { id: '110102', name: '西城区', level: 2 },
          ],
        },
      ],
    },
    {
      id: '310000',
      name: '上海',
      level: 0,
      children: [
        {
          id: '310100',
          name: '上海市',
          level: 1,
          children: [{ id: '310101', name: '黄浦区', level: 2 }],
        },
      ],
    },
  ],
  version: 'cities-3221-752308',
};

// ---------------------------------------------------------------------------
// freight templates
// ---------------------------------------------------------------------------

export const shippingTemplateListItem = z.object({
  id,
  name: z.string(),
  chargeMode: shippingChargeMode,
  hasFreeRules: z.boolean(),
  hasNoDeliveryRules: z.boolean(),
  sortOrder: z.number().int(),
  /** How many products point at this template. `0` means it is safe to delete. */
  productCount: z.number().int().min(0),
  createdAt: instant,
  updatedAt: instant,
});
export type ShippingTemplateListItem = z.infer<typeof shippingTemplateListItem>;

/** One priced region: the first `firstUnit` units cost `firstPrice`, each further `additionalUnit` costs `additionalPrice`. */
export const shippingTemplateRegion = z.object({
  /** `true` on the single rule that applies where no city rule matches. Its `cityIds` is empty. */
  isFallback: z.boolean(),
  cityIds: z.array(id),
  firstUnit: unitAmount,
  firstPrice: money,
  /** `0` means "no continuation rule": everything over the first unit is still charged `firstPrice`. */
  additionalUnit: unitAmount,
  additionalPrice: money,
});
export type ShippingTemplateRegion = z.infer<typeof shippingTemplateRegion>;

/** "Free over N units **and** ¥X" for a set of cities. Both thresholds must be met. */
export const shippingTemplateFreeRule = z.object({
  cityIds: z.array(id),
  /** `null` = the unit threshold is not used. */
  minUnits: unitAmount.nullable(),
  /** `null` = the amount threshold is not used. */
  minAmount: money.nullable(),
});
export type ShippingTemplateFreeRule = z.infer<typeof shippingTemplateFreeRule>;

export const shippingTemplateDetail = shippingTemplateListItem.extend({
  regions: z.array(shippingTemplateRegion),
  freeRules: z.array(shippingTemplateFreeRule),
  noDeliveryCityIds: z.array(id),
});
export type ShippingTemplateDetail = z.infer<typeof shippingTemplateDetail>;

/**
 * The admin form.
 *
 * The cross-field rules mirror what the database CHECKs and the quote both
 * assume, so an operator is refused in the form rather than by a 422 they
 * cannot read:
 *  - exactly one fallback region, and it carries no cities;
 *  - a free rule needs at least one threshold (the table's CHECK);
 *  - free rules only mean anything when `hasFreeRules` is on, and likewise for
 *    the no-delivery list.
 */
export const shippingTemplateForm = z
  .object({
    name: z.string().min(1).max(100),
    chargeMode: shippingChargeMode,
    hasFreeRules: z.boolean().default(false),
    hasNoDeliveryRules: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    regions: z.array(shippingTemplateRegion).min(1),
    freeRules: z.array(shippingTemplateFreeRule).default([]),
    noDeliveryCityIds: z.array(id).default([]),
  })
  .superRefine((value, ctx) => {
    const fallbacks = value.regions.filter((region) => region.isFallback);
    if (fallbacks.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['regions'],
        message: '必须且只能有一条「默认全国」区域规则',
      });
    }
    value.regions.forEach((region, index) => {
      if (region.isFallback && region.cityIds.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['regions', index, 'cityIds'],
          message: '「默认全国」规则不能再指定地区',
        });
      }
      if (!region.isFallback && region.cityIds.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['regions', index, 'cityIds'],
          message: '请选择该规则覆盖的地区',
        });
      }
    });
    value.freeRules.forEach((rule, index) => {
      if (rule.minUnits === null && rule.minAmount === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['freeRules', index, 'minAmount'],
          message: '件数/重量与金额至少填一个',
        });
      }
    });
    if (value.hasFreeRules && value.freeRules.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['freeRules'], message: '请至少添加一条包邮规则' });
    }
    if (value.hasNoDeliveryRules && value.noDeliveryCityIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['noDeliveryCityIds'],
        message: '请至少选择一个不配送地区',
      });
    }
  });
export type ShippingTemplateForm = z.infer<typeof shippingTemplateForm>;

export const shippingTemplateListQuery = pageQuery
  .extend({
    keyword: z.string().trim().min(1).max(100).optional(),
    chargeMode: shippingChargeMode.optional(),
  })
  .extend(sortQuery(['id', 'sortOrder', 'createdAt']).shape);
export type ShippingTemplateListQuery = z.infer<typeof shippingTemplateListQuery>;

export const pagedShippingTemplates = paged(shippingTemplateListItem);

/** What the product editor's 运费模板 select needs, and nothing more. */
export const shippingTemplateOption = z.object({
  id,
  name: z.string(),
  chargeMode: shippingChargeMode,
});
export const shippingTemplateOptions = z.object({ items: z.array(shippingTemplateOption) });
export type ShippingTemplateOptions = z.infer<typeof shippingTemplateOptions>;

/**
 * 运费试算: the template as the editor holds it — saved or not — priced for one
 * product sent to one division. `units` is in the template's own unit (件, kg
 * or m³) and `amount` is the goods total the free-shipping rules compare with.
 */
export const shippingTemplateTrialBody = z.object({
  template: shippingTemplateForm,
  cityId: id,
  units: unitAmount.refine((value) => value > 0, { message: '请输入大于 0 的数量' }),
  amount: money,
});
export type ShippingTemplateTrialBody = z.infer<typeof shippingTemplateTrialBody>;

export const shippingTemplateTrialOutcome = z.enum([
  'charged',
  'free-by-rule',
  'free-by-threshold',
  'undeliverable',
]);

/** The fee, and the path to it in the operator's words: 地址 → 命中规则 → 计算. */
export const shippingTemplateTrialResult = z.object({
  outcome: shippingTemplateTrialOutcome,
  fee: money,
  steps: z.array(z.string()),
});
export type ShippingTemplateTrialResult = z.infer<typeof shippingTemplateTrialResult>;

export const shippingTemplateExample: ShippingTemplateListItem = {
  id: '1',
  name: '全国包邮（满 5 件）',
  chargeMode: 'quantity',
  hasFreeRules: true,
  hasNoDeliveryRules: true,
  sortOrder: 10,
  productCount: 24,
  createdAt: '2026-01-05T10:00:00+08:00',
  updatedAt: '2026-02-01T09:30:00+08:00',
};

export const shippingTemplateDetailExample: ShippingTemplateDetail = {
  ...shippingTemplateExample,
  regions: [
    {
      isFallback: true,
      cityIds: [],
      firstUnit: 1,
      firstPrice: '10.00',
      additionalUnit: 1,
      additionalPrice: '5.00',
    },
    {
      isFallback: false,
      cityIds: ['110100', '310100'],
      firstUnit: 2,
      firstPrice: '6.00',
      additionalUnit: 1,
      additionalPrice: '2.00',
    },
  ],
  freeRules: [{ cityIds: ['110100'], minUnits: 5, minAmount: '199.00' }],
  noDeliveryCityIds: ['820000'],
};

// ---------------------------------------------------------------------------
// courier companies
// ---------------------------------------------------------------------------

/**
 * The picker shape. `GET /admin-api/express-companies` answers with this and
 * nothing else, so the console's 发货 form reads exactly the list it offers.
 */
export const expressCompany = z.object({
  id,
  code: z.string(),
  name: z.string(),
  /** Companies an operator uses often sort first. */
  sortOrder: z.number().int(),
});
export type ExpressCompany = z.infer<typeof expressCompany>;

export const expressCompanyList = z.object({ items: z.array(expressCompany) });

export const expressCompanyListExample = {
  items: [
    { id: '12', code: 'SF', name: '顺丰速运', sortOrder: 100 },
    { id: '13', code: 'ZTO', name: '中通快递', sortOrder: 90 },
  ],
} satisfies z.infer<typeof expressCompanyList>;

/**
 * `GET /api/v1/express-companies` — the shopper's 退货物流 picker. Enabled carriers only, at
 * most `limit` of them, those with a WeChat courier code (`wechatDeliveryId`, which
 * 小程序发货信息管理 needs) first, then by `sortOrder`. `keyword` matches the name or the
 * tracking code, case-insensitively, anywhere in it; blank is no filter. Without either
 * parameter the answer is the first 50 — the seeded table has about 1100 rows, and a phone
 * has no use for all of them.
 */
export const expressCompanyOptionsQuery = z.object({
  keyword: z.string().trim().max(50).optional(),
  limit: z.coerce.number<number | string>().int().min(1).max(100).default(50),
});
export type ExpressCompanyOptionsQuery = z.infer<typeof expressCompanyOptionsQuery>;

/** The management row. Carries `isEnabled`, which the picker never does — the picker only lists enabled ones. */
export const expressCompanyRow = expressCompany.extend({
  isEnabled: z.boolean(),
  /**
   * The carrier's code in WeChat's list (小程序发货信息管理, `get_delivery_list`'s
   * `delivery_id`, e.g. `SF`). `null` until filled in; a mini-program shipment by
   * a carrier without one cannot be reported to WeChat.
   */
  wechatDeliveryId: z.string().nullable(),
  createdAt: instant,
  updatedAt: instant,
});
export type ExpressCompanyRow = z.infer<typeof expressCompanyRow>;

export const expressCompanyForm = z.object({
  /** The carrier code the tracking provider knows it by, e.g. `SF`. Unique. */
  code: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[A-Za-z0-9_-]+$/, '编码只能包含字母、数字、下划线和连字符'),
  name: z.string().trim().min(1).max(100),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  isEnabled: z.boolean().default(true),
  /** WeChat's `delivery_id` for this carrier. Omitted: unchanged on edit, none on create; `null` clears it. */
  wechatDeliveryId: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, '微信快递编码只能包含字母、数字、下划线和连字符')
    .nullable()
    .optional(),
});
export type ExpressCompanyForm = z.infer<typeof expressCompanyForm>;

export const expressCompanyStatusBody = z.object({ isEnabled: z.boolean() });

export const expressCompanyListQuery = pageQuery
  .extend({
    keyword: z.string().trim().min(1).max(100).optional(),
    isEnabled: z.stringbool().optional(),
  })
  .extend(sortQuery(['id', 'sortOrder', 'name']).shape);
export type ExpressCompanyListQuery = z.infer<typeof expressCompanyListQuery>;

export const pagedExpressCompanies = paged(expressCompanyRow);

export const expressCompanyRowExample: ExpressCompanyRow = {
  id: '12',
  code: 'SF',
  name: '顺丰速运',
  sortOrder: 100,
  isEnabled: true,
  wechatDeliveryId: 'SF',
  createdAt: '2026-01-01T00:00:00+08:00',
  updatedAt: '2026-01-01T00:00:00+08:00',
};
