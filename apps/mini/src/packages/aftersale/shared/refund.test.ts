import { describe, expect, it } from 'vitest';
import { refundableItem, refundListItem } from '@/test/order-fixtures';
import {
  awaitsReturn,
  canCancel,
  canHide,
  fromCents,
  lineEstimate,
  refundStatusText,
  toCents,
} from './refund';

describe('refund helpers', () => {
  it('turns money strings into cents and back', () => {
    expect(toCents('12.3')).toBe(1230);
    expect(toCents('0.05')).toBe(5);
    expect(toCents('100')).toBe(10000);
    expect(fromCents(1230)).toBe('12.30');
    expect(fromCents(5)).toBe('0.05');
  });

  it('estimates a line: all of it for every unit, a share rounded down for some', () => {
    const item = refundableItem('1', { refundableQuantity: 3, refundableAmount: '100.00' });
    expect(lineEstimate(item, 3)).toBe(10000);
    expect(lineEstimate(item, 1)).toBe(3333);
    expect(lineEstimate(item, 0)).toBe(0);
  });

  it('says where a return stands', () => {
    const r = refundListItem({ kind: 'return_and_refund', status: 'approved' });
    expect(refundStatusText({ ...r, returnStage: 'awaiting_shipment' })).toBe('待寄回商品');
    expect(refundStatusText({ ...r, returnStage: 'shipped_back' })).toBe('待商家收货');
    expect(awaitsReturn({ ...r, returnStage: 'awaiting_shipment' })).toBe(true);
    expect(awaitsReturn({ ...r, returnStage: 'shipped_back' })).toBe(false);
    expect(refundStatusText(refundListItem({ status: 'succeeded' }))).toBe('退款成功');
  });

  it('REFUND-017 — shows a failed refund as in progress, keeps it, and lets the shopper withdraw it', () => {
    const failed = refundListItem({ status: 'failed' });
    expect(refundStatusText(failed)).toBe('退款处理中');
    expect(canHide(failed)).toBe(false);
    expect(canCancel(failed)).toBe(true);
    expect(canHide(refundListItem({ status: 'rejected' }))).toBe(true);
  });

  it('never offers 撤销申请 on a refund the shop opened itself', () => {
    expect(canCancel(refundListItem({ status: 'approved', isAutomatic: true }))).toBe(false);
    expect(canCancel(refundListItem({ status: 'approved' }))).toBe(true);
    expect(canCancel(refundListItem({ status: 'processing' }))).toBe(false);
  });
});
