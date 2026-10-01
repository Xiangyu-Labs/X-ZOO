import { defineErrors } from '../_conventions/errors';

/**
 * Shipping error codes — freight templates, cities, courier companies.
 *
 * One code per decision a caller can act on. In particular there is exactly one
 * "we will not ship this there" code: the quote learns it from a single
 * `NOT EXISTS` over the no-delivery join, and the shopper's next move is the
 * same whichever line caused it — change the address or drop the line. The
 * offending SKUs travel in `details` so the cart can grey the right rows.
 */
export const shippingErrors = defineErrors({
  /** The template id does not exist or is soft-deleted. */
  SHIPPING_TEMPLATE_NOT_FOUND: { status: 404, message: '运费模板不存在' },
  /**
   * A product still points at the template. Deleting it would silently move
   * those products onto "no template", which quotes zero freight.
   * `details` carries `{ productCount }`.
   */
  SHIPPING_TEMPLATE_IN_USE: {
    status: 409,
    message: '该运费模板正在被商品或进行中的活动使用，无法删除',
  },
  /**
   * A region / free-shipping / no-delivery row named a city id that is not in
   * the seeded tree. `details` carries `{ cityIds }`.
   */
  SHIPPING_CITY_UNKNOWN: { status: 422, message: '所选地区不存在，请重新选择' },
  /**
   * Two rules of one template claim the same city, so the quote could not say
   * which price applies. `details` carries `{ cityIds }`.
   */
  SHIPPING_REGION_OVERLAP: { status: 422, message: '同一模板的配送区域不能重复' },
  /**
   * The destination is on the template's no-delivery list.
   * `details` carries `{ skuIds, templateIds }`.
   */
  SHIPPING_NOT_DELIVERABLE: { status: 409, message: '部分商品不支持配送到所选地区' },

  /** The courier company id does not exist. */
  SHIPPING_EXPRESS_COMPANY_NOT_FOUND: { status: 404, message: '快递公司不存在' },
  /** `express_companies_code_uq` refused the insert. `details` carries `{ code }`. */
  SHIPPING_EXPRESS_COMPANY_CODE_TAKEN: { status: 409, message: '该快递公司编码已存在' },
  /**
   * A shipment or a return still references the company. Disable it instead —
   * a disabled company keeps its history and leaves the picker.
   */
  SHIPPING_EXPRESS_COMPANY_IN_USE: { status: 409, message: '该快递公司已被使用，请改为停用' },
});

export type ShippingErrorCode = keyof typeof shippingErrors;
