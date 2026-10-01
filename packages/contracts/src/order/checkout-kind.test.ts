import { describe, expect, it } from 'vitest';
import { checkoutCreateBody, checkoutPreviewBody } from './schemas';

/**
 * `kind` + `kindMeta` as one discriminated union (ORDER-009).
 *
 * The payloads under "what the legacy client sends" are the exact bodies the
 * old uni-app's order mappers produced (the app was deleted at the cutover).
 * Typing the field must not refuse any of them.
 */

const BUY_NOW = { source: 'buy-now', item: { skuId: '21', quantity: 1 } } as const;

describe('ORDER-009 — typed kindMeta', () => {
  describe('what the legacy client sends still parses', () => {
    it.each([
      ['an ordinary cart order', { kind: 'normal', source: 'cart', cartItemIds: ['5001', '5002'] }],
      ['an ordinary 立即购买', { kind: 'normal', ...BUY_NOW }],
      ['a 开团 order', { kind: 'groupbuy', ...BUY_NOW, kindMeta: { activityId: '1' } }],
      [
        'a 参团 order',
        { kind: 'groupbuy', ...BUY_NOW, kindMeta: { activityId: '1', groupId: '501' } },
      ],
      ['a 预售 order', { kind: 'presale', ...BUY_NOW, kindMeta: { activityId: '2' } }],
    ])('previews %s', (_label, body) => {
      expect(checkoutPreviewBody.safeParse(body).success).toBe(true);
    });

    it('creates a 参团 order with the create-only fields alongside', () => {
      const parsed = checkoutCreateBody.parse({
        kind: 'groupbuy',
        ...BUY_NOW,
        kindMeta: { activityId: '1', groupId: '501' },
        addressId: '301',
        idempotencyKey: 'ck-20260201-7f3a9b21',
        buyerRemark: '工作日送达',
        expectedPayableAmount: '59.00',
      });
      expect(parsed).toMatchObject({
        kind: 'groupbuy',
        kindMeta: { activityId: '1', groupId: '501' },
        idempotencyKey: 'ck-20260201-7f3a9b21',
        expectedPayableAmount: '59.00',
      });
    });

    it('still defaults a body with no kind at all to an ordinary order', () => {
      expect(checkoutPreviewBody.parse({ source: 'cart' })).toMatchObject({ kind: 'normal' });
    });

    it('accepts the numeric ids the untyped record used to let through, as strings', () => {
      const parsed = checkoutPreviewBody.parse({
        kind: 'groupbuy',
        ...BUY_NOW,
        kindMeta: { activityId: 12, groupId: 7 },
      });
      expect(parsed.kind === 'groupbuy' && parsed.kindMeta).toEqual({
        activityId: '12',
        groupId: '7',
      });
    });
  });

  describe('what the union tightens', () => {
    it('narrows kindMeta by kind', () => {
      const parsed = checkoutPreviewBody.parse({
        kind: 'presale',
        ...BUY_NOW,
        kindMeta: { activityId: '2' },
      });
      if (parsed.kind !== 'presale') throw new Error('expected a presale body');
      // Typed: no cast, and `activityId` is a string.
      const activityId: string = parsed.kindMeta.activityId;
      expect(activityId).toBe('2');
    });

    it('strips a key the kind does not declare, above all a smuggled kind', () => {
      const parsed = checkoutPreviewBody.parse({
        kind: 'presale',
        ...BUY_NOW,
        kindMeta: { activityId: '2', kind: 'groupbuy', couponId: '9' },
      });
      expect(parsed.kind === 'presale' && parsed.kindMeta).toEqual({ activityId: '2' });
    });

    it('discards whatever kindMeta an ordinary order carries', () => {
      const parsed = checkoutPreviewBody.parse({
        kind: 'normal',
        source: 'cart',
        kindMeta: { kind: 'groupbuy', activityId: '1' },
      });
      expect(parsed.kind).toBe('normal');
      expect(parsed.kindMeta).toBeUndefined();
    });

    it('discards a presale kind smuggled into an ordinary order, on create too', () => {
      const parsed = checkoutCreateBody.parse({
        kind: 'normal',
        ...BUY_NOW,
        kindMeta: { kind: 'presale', activityId: '2' },
        idempotencyKey: 'ck-20260201-7f3a9b21',
      });
      expect(parsed.kind).toBe('normal');
      expect(parsed.kindMeta).toBeUndefined();
    });

    it('refuses a kind the union does not know, however kindMeta is dressed', () => {
      expect(
        checkoutCreateBody.safeParse({
          ...BUY_NOW,
          kind: 'PRESALE',
          kindMeta: { activityId: '2' },
          idempotencyKey: 'ck-20260201-7f3a9b21',
        }).success,
      ).toBe(false);
    });

    it.each([
      ['a group-buy order with no kindMeta', { kind: 'groupbuy', ...BUY_NOW }],
      ['a presale order with no activity', { kind: 'presale', ...BUY_NOW, kindMeta: {} }],
      [
        'an activity id that is not an id',
        { kind: 'presale', ...BUY_NOW, kindMeta: { activityId: '0' } },
      ],
      ['a negative number', { kind: 'groupbuy', ...BUY_NOW, kindMeta: { activityId: -3 } }],
      ['an unknown kind', { kind: 'wholesale', ...BUY_NOW }],
    ])('refuses %s', (_label, body) => {
      expect(checkoutPreviewBody.safeParse(body).success).toBe(false);
    });

    it('keeps the 立即购买 rule on top of the union', () => {
      const result = checkoutPreviewBody.safeParse({ kind: 'normal', source: 'buy-now' });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['item']);
    });
  });
});
