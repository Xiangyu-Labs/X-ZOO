import { describe, expect, it } from 'vitest';
import {
  activityCard,
  activityDeadline,
  activityPhase,
  salesText,
  shipText,
  ttlText,
} from './activity';

const NOW = Date.parse('2026-09-24T10:00:00Z');
const window = {
  startAt: '2026-09-20T00:00:00Z',
  endAt: '2026-09-30T00:00:00Z',
  stock: 5,
  canBuy: true,
};

describe('activityPhase', () => {
  it.each([
    ['on', window, 'on'],
    ['upcoming', { ...window, startAt: '2026-09-25T00:00:00Z' }, 'upcoming'],
    ['ended', { ...window, endAt: '2026-09-24T09:00:00Z' }, 'ended'],
    ['sold out', { ...window, stock: 0, canBuy: false }, 'sold-out'],
    ['paused by the shop', { ...window, canBuy: false }, 'unavailable'],
  ] as const)('%s', (_name, activity, phase) => {
    expect(activityPhase(activity, NOW)).toBe(phase);
  });
});

describe('activityDeadline', () => {
  it('counts down to the start, then to the end, and to nothing after', () => {
    expect(activityDeadline(window, 'upcoming')).toEqual({ label: '距开始', at: window.startAt });
    expect(activityDeadline(window, 'on')).toEqual({ label: '距结束', at: window.endAt });
    expect(activityDeadline(window, 'ended')).toBeNull();
  });
});

describe('words', () => {
  it('says when a presale ships and hides zero sales', () => {
    expect(shipText(7)).toBe('付款后 7 天内发货');
    expect(shipText(0)).toBe('付款后尽快发货');
    expect(salesText('已拼', 0)).toBe('');
    expect(salesText('已售', 3)).toBe('已售 3 件');
  });
});

describe('ttlText', () => {
  it('says days, hours or minutes', () => {
    expect(ttlText(86400)).toBe('1 天');
    expect(ttlText(2 * 86400)).toBe('2 天');
    expect(ttlText(36 * 3600)).toBe('36 小时');
    expect(ttlText(5400)).toBe('1.5 小时');
    expect(ttlText(600)).toBe('10 分钟');
  });
});

describe('activityCard', () => {
  const card = {
    activityId: '1',
    title: '双人团',
    intro: null,
    imageUrl: null,
    price: '59.00',
    originalPrice: '88.00' as string | null,
    stock: 3,
    sales: 0,
  };

  it('shows the activity price with the list price struck', () => {
    const { product, activityPrice } = activityCard(card);
    expect(product).toMatchObject({ id: '1', name: '双人团', price: '88.00', imageUrl: '' });
    expect(activityPrice).toBe('59.00');
  });

  it('shows the activity price alone without a list price', () => {
    const { product, activityPrice } = activityCard({ ...card, originalPrice: null });
    expect(product.price).toBe('59.00');
    expect(activityPrice).toBeUndefined();
  });
});
