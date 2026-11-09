import { describe, expect, it } from 'vitest';
import { productPromotionAdmin, productPromotionInput } from './promotion';
const settings = {
  endAt: '2099-12-31T23:59:59+08:00',
  shipAfterDays: 10,
  seatsRequired: 2,
  skus: [{ specValues: {}, price: '49.00' }],
};
describe('product promotion form', () => {
  it('accepts exactly one sale mode and rejects an invented combined mode', () => {
    for (const mode of ['normal', 'presale', 'groupbuy'])
      expect(productPromotionInput.safeParse({ mode, expectedVersion: 0, settings }).success).toBe(
        true,
      );
    expect(
      productPromotionInput.safeParse({ mode: 'presale-groupbuy', expectedVersion: 0, settings })
        .success,
    ).toBe(false);
  });
  it('requires shipment days for presales and seats for group buys', () => {
    const { shipAfterDays: _days, ...withoutDays } = settings;
    const { seatsRequired: _seats, ...withoutSeats } = settings;
    expect(
      productPromotionInput.safeParse({
        mode: 'presale',
        expectedVersion: 0,
        settings: withoutDays,
      }).success,
    ).toBe(false);
    expect(
      productPromotionInput.safeParse({
        mode: 'groupbuy',
        expectedVersion: 0,
        settings: withoutSeats,
      }).success,
    ).toBe(false);
  });
  it('gives an actionable Chinese message for an empty activity price', () => {
    const parsed = productPromotionInput.safeParse({
      mode: 'presale',
      expectedVersion: 0,
      settings: { ...settings, skus: [{ specValues: {}, price: '' }] },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe('请填写活动价格');
  });
  it('rejects reversed time windows, fractional seats, and float money', () => {
    expect(
      productPromotionInput.safeParse({
        mode: 'presale',
        expectedVersion: 0,
        settings: { ...settings, startAt: '2100-01-01T00:00:00+08:00' },
      }).success,
    ).toBe(false);
    expect(
      productPromotionInput.safeParse({
        mode: 'groupbuy',
        expectedVersion: 0,
        settings: { ...settings, seatsRequired: 2.5 },
      }).success,
    ).toBe(false);
    expect(
      productPromotionInput.safeParse({
        mode: 'presale',
        expectedVersion: 0,
        settings: { ...settings, skus: [{ specValues: {}, price: 49 }] },
      }).success,
    ).toBe(false);
  });
});

it('reads legacy activities with no configured SKU without accepting an incomplete new form', () => {
  const state = {
    mode: 'presale',
    version: 1,
    activityId: '7',
    conflict: false,
    candidates: [
      {
        kind: 'presale',
        activityId: '7',
        title: '未配置规格的旧预售',
        status: 'draft',
        settings: { ...settings, skus: [] },
      },
    ],
  };
  expect(productPromotionAdmin.safeParse(state).success).toBe(true);
  expect(
    productPromotionInput.safeParse({
      mode: 'presale',
      expectedVersion: 1,
      settings: { ...settings, skus: [] },
    }).success,
  ).toBe(false);
});

it('compares campaign windows as instants across Shanghai and UTC offsets', async () => {
  const { presaleActivityForm } = await import('../presale/schemas');
  const { groupbuyActivityForm } = await import('../groupbuy/schemas');
  const body = {
    productId: '12',
    title: '时区验证',
    price: '49.00',
    stock: 10,
    seatsRequired: 2,
    groupTtlSeconds: 86400,
    startAt: '2026-09-01T10:00:00+08:00',
    endAt: '2026-09-01T03:00:00Z',
  };
  expect(presaleActivityForm.safeParse(body).success).toBe(true);
  expect(groupbuyActivityForm.safeParse(body).success).toBe(true);
  expect(presaleActivityForm.safeParse({ ...body, endAt: '2026-09-01T01:00:00Z' }).success).toBe(
    false,
  );
  expect(groupbuyActivityForm.safeParse({ ...body, endAt: '2026-09-01T01:00:00Z' }).success).toBe(
    false,
  );
});
