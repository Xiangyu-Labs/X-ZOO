import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  applicableCouponsBody,
  applicableCouponsResult,
  claimResult,
  claimableCouponExample,
  claimableCouponListQuery,
  myCouponListQuery,
  pagedClaimableCoupons,
  pagedMyCoupons,
  userCouponExample,
} from './schemas';

/**
 * Storefront coupon routes, `/api/v1/coupons` and `/api/v1/user-coupons`.
 *
 * `/coupons` is `user-optional`: the 领券中心 must render for a visitor who has
 * not logged in, and the per-caller fields come back `null` rather than the
 * whole list 401-ing. Everything that touches a wallet is `user`.
 */

export const couponClaimableList = defineRoute({
  id: 'coupon.claimableList',
  method: 'GET',
  path: '/api/v1/coupons',
  auth: 'user-optional',
  summary: '可领取的优惠券',
  tags: ['coupon'],
  query: claimableCouponListQuery,
  response: pagedClaimableCoupons,
  examples: [
    {
      name: 'signed-in',
      query: { page: 1, pageSize: 20 },
      response: { items: [claimableCouponExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'anonymous',
      query: { page: 1, pageSize: 20 },
      response: {
        items: [{ ...claimableCouponExample, claimedCount: null, canClaim: null }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    },
    {
      // A DIY component's 指定数据: template 5 has run out, so it is skipped.
      name: 'picked',
      query: { page: 1, pageSize: 2, ids: '1,5' },
      response: { items: [claimableCouponExample], total: 1, page: 1, pageSize: 2 },
    },
    {
      // The 商品详情 领券 sheet: shop-wide coupons plus those naming the product or its category.
      name: 'for-a-product',
      query: { page: 1, pageSize: 20, productId: '11' },
      response: { items: [claimableCouponExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const couponNewUserList = defineRoute({
  id: 'coupon.newUserList',
  method: 'GET',
  path: '/api/v1/coupons/new-user',
  auth: 'user-optional',
  summary: '新人券',
  tags: ['coupon'],
  response: z.object({ items: z.array(pagedClaimableCoupons.shape.items.element) }),
  examples: [
    {
      name: 'ok',
      response: {
        items: [
          {
            ...claimableCouponExample,
            templateId: '2',
            name: '新人专享 5 元券',
            discountAmount: '5.00',
            minSpend: '0.00',
            validityMode: 'days_after_claim',
            validFrom: null,
            validTo: null,
            validDays: 30,
            claimTo: null,
            isUnlimitedSupply: true,
            remainingCount: null,
            perUserLimit: 1,
            claimedCount: 0,
            // Issued on registration, never claimed by hand.
            canClaim: false,
          },
        ],
      },
    },
  ],
});

export const couponClaim = defineRoute({
  id: 'coupon.claim',
  method: 'POST',
  path: '/api/v1/coupons/:id/claims',
  auth: 'user',
  summary: '领取优惠券',
  tags: ['coupon'],
  params: z.object({ id }),
  body: z.object({}).default({}),
  response: claimResult,
  status: 201,
  errors: [
    'COUPON_TEMPLATE_NOT_FOUND',
    'COUPON_NOT_CLAIMABLE',
    'COUPON_CLAIM_WINDOW_CLOSED',
    'COUPON_SOLD_OUT',
    'COUPON_PER_USER_LIMIT_REACHED',
  ],
  examples: [
    {
      name: 'ok',
      params: { id: '1' },
      body: {},
      response: { coupon: userCouponExample, remainingCount: 872 },
    },
  ],
});

export const couponMyList = defineRoute({
  id: 'coupon.myList',
  method: 'GET',
  path: '/api/v1/user-coupons',
  auth: 'user',
  summary: '我的优惠券',
  tags: ['coupon'],
  query: myCouponListQuery,
  response: pagedMyCoupons,
  examples: [
    {
      name: 'unused',
      query: { page: 1, pageSize: 20, state: 'unused' },
      response: { items: [userCouponExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'used',
      query: { page: 1, pageSize: 20, state: 'used' },
      response: {
        items: [{ ...userCouponExample, status: 'used', usedAt: '2026-02-01T12:00:00+08:00' }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    },
  ],
});

/**
 * The checkout picker.
 *
 * POST because the cart is the input and it does not fit in a query string —
 * this is a read, not a state change, and it writes nothing.
 */
export const couponApplicableList = defineRoute({
  id: 'coupon.applicableList',
  method: 'POST',
  path: '/api/v1/user-coupons/applicable',
  auth: 'user',
  summary: '下单可用的优惠券',
  tags: ['coupon'],
  body: applicableCouponsBody,
  response: applicableCouponsResult,
  examples: [
    {
      name: 'one-usable-one-not',
      body: {
        lines: [
          { productId: '11', amount: '120.00' },
          { productId: '12', amount: '30.00' },
        ],
      },
      response: {
        subtotal: '150.00',
        items: [
          {
            coupon: userCouponExample,
            usable: true,
            discount: '10.00',
            eligibleLineIndexes: [0, 1],
            reason: null,
          },
          {
            coupon: {
              ...userCouponExample,
              id: '9002',
              templateId: '3',
              title: '母婴满 200 减 30',
              discountAmount: '30.00',
              minSpend: '200.00',
              scope: 'categories',
            },
            usable: false,
            discount: '0.00',
            eligibleLineIndexes: [0],
            reason: 'COUPON_MIN_SPEND_NOT_MET',
          },
        ],
      },
    },
  ],
});
