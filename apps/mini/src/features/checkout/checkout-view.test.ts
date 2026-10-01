import { describe, expect, it } from 'vitest';
import { ApiError } from '@shop/api-client';
import { applicableFixture, previewFixture } from '@/test/checkout-fixture';
import {
  checkoutPrices,
  checkoutRefusal,
  couponLinesOf,
  freightText,
  couponReason,
  customFormBody,
  customFormProblem,
  resolveCoupon,
  type CustomFormField,
} from './checkout-view';
import { checkoutBody, subscribeSceneOf } from './draft';

const fields: CustomFormField[] = [
  { key: 'name', label: '刻字内容', type: 'text', required: true },
  { key: 'size', label: '尺码', type: 'number', required: false },
  { key: 'day', label: '送达日期', type: 'date', required: false },
  { key: 'colors', label: '颜色', type: 'checkbox', required: true, options: ['红', '黑'] },
  { key: 'photo', label: '参考图', type: 'image', required: true },
];

describe('checkout view', () => {
  it('builds the body for each draft kind', () => {
    expect(
      checkoutBody(
        { source: 'cart', cartItemIds: ['1'], kind: 'normal' },
        { addressId: '301', userCouponId: null },
      ),
    ).toEqual({
      source: 'cart',
      cartItemIds: ['1'],
      kind: 'normal',
      addressId: '301',
      userCouponId: null,
    });
    expect(
      checkoutBody({
        source: 'buy-now',
        item: { skuId: '9', quantity: 1 },
        kind: 'groupbuy',
        kindMeta: { activityId: '7', groupId: '3' },
      }),
    ).toEqual({
      source: 'buy-now',
      item: { skuId: '9', quantity: 1 },
      kind: 'groupbuy',
      kindMeta: { activityId: '7', groupId: '3' },
    });
    expect(subscribeSceneOf({ kind: 'presale', kindMeta: { activityId: '1' } })).toBe(
      'presaleCheckout',
    );
    expect(subscribeSceneOf({ kind: 'normal' })).toBe('checkout');
  });

  it('picks the best usable coupon unless the shopper chose', () => {
    const coupons = applicableFixture();
    expect(resolveCoupon({ mode: 'auto' }, coupons)).toBe('901');
    expect(resolveCoupon({ mode: 'auto' }, undefined)).toBeNull();
    expect(resolveCoupon({ mode: 'none' }, coupons)).toBeNull();
    expect(resolveCoupon({ mode: 'picked', id: 'uc9' }, coupons)).toBe('uc9');
    expect(couponLinesOf(previewFixture())).toEqual([{ productId: '12', amount: '118.00' }]);
    expect(couponReason('COUPON_MIN_SPEND_NOT_MET')).toBe('未达到使用门槛');
    expect(couponReason('SOMETHING_NEW')).toBe('暂不可用');
  });

  it('checks the custom form and sends the answers', () => {
    expect(customFormProblem(fields, {})).toBe('请填写「刻字内容」');
    expect(customFormProblem(fields, { name: '安', colors: [] })).toBe('请填写「颜色」');
    expect(customFormProblem(fields, { name: '安', colors: ['红'], size: 'L' })).toBe(
      '「尺码」请填写数字',
    );
    expect(customFormProblem(fields, { name: '安', colors: ['红'], day: '10/1' })).toBe(
      '「送达日期」请按 2026-01-31 的格式填写',
    );
    // The picture field cannot be filled in here, so it does not block the order.
    expect(customFormProblem(fields, { name: '安', colors: ['红'] })).toBeNull();
    expect(customFormBody(fields, { name: ' 安 ', size: '38', colors: ['红'], day: '' })).toEqual({
      name: '安',
      size: 38,
      colors: ['红'],
    });
    expect(customFormBody(fields, {})).toBeUndefined();
  });

  it('prints a 拼团 line at the 拼团 price, and 优惠券 as the coupon alone', () => {
    // ¥88 catalogue × 1, 拼团 ¥78 (an adjustment of -10) and a ¥5 coupon: couponDiscount 15.
    const preview = previewFixture({
      lines: [
        {
          ...previewFixture().lines[0]!,
          quantity: 1,
          unitPrice: '88.00',
          subtotal: '88.00',
          discountAmount: '15.00',
          totalAmount: '73.00',
        },
      ],
      itemsAmount: '88.00',
      couponDiscount: '15.00',
      adjustments: [
        { source: 'groupbuy:activity-price', label: '拼团价', amount: '-10.00' },
        { source: 'coupon:full-reduction', label: '优惠券抵扣', amount: '-5.00' },
        { source: 'promo:full-reduction', label: '满减', amount: '-0.00' },
      ],
    });
    const prices = checkoutPrices(preview);
    expect(prices.unitPrices['sku-103']).toBe('78.00');
    expect(prices.itemsAmount).toBe('78.00');
    expect(prices.couponDiscount).toBe('5.00');
    expect(prices.otherAdjustments.map((row) => row.label)).toEqual(['满减']);
    // A plain order reads as sent.
    const plain = checkoutPrices(previewFixture());
    expect(plain).toMatchObject({ itemsAmount: '118.00', couponDiscount: '0.00' });
    expect(plain.unitPrices['sku-103']).toBe('59.00');
  });

  it('says 请选择收货地址 for freight before there is an address, not 包邮', () => {
    expect(freightText(previewFixture({ receiver: null, freightAmount: '0.00' }))).toBe(
      '请选择收货地址',
    );
    expect(freightText(previewFixture({ freightAmount: '0.00' }))).toBe('包邮');
    expect(freightText(previewFixture())).toBe('¥8.00');
    expect(
      freightText(
        previewFixture({ receiver: null, addressRequired: false, freightAmount: '0.00' }),
      ),
    ).toBe('包邮');
  });

  it('names the item a refusal is about, and leaves the rest to the page', () => {
    const draft = {
      source: 'cart' as const,
      cartItemIds: ['1'],
      kind: 'normal' as const,
      names: { '103': '柔雾丝绒礼盒' },
    };
    const refused = (code: string, details: unknown, status = 409) =>
      checkoutRefusal(new ApiError({ status, code, message: '服务端的话', details }), draft);
    expect(
      refused('ORDER_PURCHASE_LIMIT_REACHED', { skuId: '103', limit: 2, purchased: 2 }),
    ).toEqual({
      title: '「柔雾丝绒礼盒」每人限购 2 件',
      description: '你已购买过 2 件，不能再购买了',
    });
    expect(refused('ORDER_PURCHASE_LIMIT_REACHED', { skuId: '103', limit: 3 })?.title).toBe(
      '「柔雾丝绒礼盒」每单限购 3 件',
    );
    expect(refused('ORDER_ITEM_UNAVAILABLE', { skuIds: ['103'] })).toEqual({
      title: '「柔雾丝绒礼盒」已下架或暂不可购买',
      description: '请返回购物车调整后再结算',
    });
    expect(refused('ORDER_BELOW_MIN_PURCHASE', { skuId: '9', minimum: 2 }, 422)?.title).toBe(
      '该商品最少购买 2 件',
    );
    expect(refused('GROUPBUY_ACTIVITY_ENDED', {})?.title).toBe('服务端的话');
    expect(refused('COUPON_NOT_USABLE', {})).toBeNull();
    expect(refused('SHIPPING_NOT_DELIVERABLE', {})).toBeNull();
    expect(refused('INTERNAL', {}, 500)).toBeNull();
  });
});
