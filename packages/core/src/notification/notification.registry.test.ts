import { beforeAll, describe, expect, it } from 'vitest';
// Test-only: each domain's event declarations, without the domain itself (its
// `index.ts` would pull in its services and repositories for a pure check).
/* eslint-disable boundaries/core-cross-domain */
import { registerGroupbuyNotificationEvents } from '../groupbuy/groupbuy.notifications';
import { registerPaymentNotificationEvents } from '../payment/payment.notifications';
import { registerPresaleNotificationEvents } from '../presale/presale.notifications';
import { registerRefundNotificationEvents } from '../refund/refund.notifications';
/* eslint-enable boundaries/core-cross-domain */
import {
  allNotificationEvents,
  approvedRefundNote,
  registerBuiltInNotificationEvents,
  settledRefundNote,
} from './notification.registry';
import { render } from './notification.render';
import { placeholdersIn } from './notification.render';

beforeAll(() => {
  registerBuiltInNotificationEvents();
  registerGroupbuyNotificationEvents();
  registerPresaleNotificationEvents();
  registerPaymentNotificationEvents();
  registerRefundNotificationEvents();
});

describe('NOTIF-007 — an event’s wording names only the variables it declares', () => {
  it('declares every placeholder its default title, body, link and route use', () => {
    const undeclared = allNotificationEvents().flatMap((event) => {
      const wording = [
        event.defaults.title,
        event.defaults.body,
        event.link ?? '',
        ...Object.values(event.route?.params ?? {}),
      ].join(' ');
      return placeholdersIn(wording)
        .filter((name) => !event.variables.includes(name))
        .map((name) => `${event.code}: {{${name}}}`);
    });
    expect(undeclared).toEqual([]);
  });
});

describe('NOTIF-009 — an event offers only the variables its senders fill', () => {
  it('lists no nickname and no amount where the hook carries none', () => {
    const events = new Map(allNotificationEvents().map((event) => [event.code, event]));
    expect(
      [...events.values()]
        .filter((event) => event.variables.includes('nickname'))
        .map((e) => e.code),
    ).toEqual([]);
    expect(events.get('order_cancelled')?.variables).toEqual(['orderId', 'orderNo', 'reason']);
    expect(events.get('order_completed')?.variables).toEqual(['orderId', 'orderNo']);
    // 未付款提醒 is sent now, by `order.remindUnpaid`.
    expect(events.get('order_unpaid_reminder')?.variables).toEqual([
      'orderId',
      'orderNo',
      'amount',
      'expiresAt',
    ]);
    // 用户确认收货提醒 is sent now, from the fulfilment notifier.
    expect(events.get('admin_order_received')?.variables).toEqual(['orderId', 'orderNo', 'amount']);
  });
});

describe('NOTIF-011 — a ¥0 refund is not announced as money on its way back', () => {
  const body = (code: string, data: Record<string, string>) =>
    render(allNotificationEvents().find((event) => event.code === code)!.defaults.body, data);

  it('says 原路退回 with the amount for a paid refund', () => {
    expect(
      body('refund_approved', {
        refundNo: 'RF1',
        orderNo: 'SO1',
        refundNote: approvedRefundNote('60.00', 'refund_only'),
      }),
    ).toBe('退款单 RF1 已通过审核，订单 SO1 的 ¥60.00 将原路退回。');
    expect(
      body('refund_settled', { refundNo: 'RF1', refundNote: settledRefundNote('60.00') }),
    ).toBe('退款单 RF1 的 ¥60.00 已原路退回。');
  });

  it('says there is nothing to return for a refund worth ¥0', () => {
    expect(
      body('refund_approved', {
        refundNo: 'RF2',
        orderNo: 'SO2',
        refundNote: approvedRefundNote('0.00', 'refund_only'),
      }),
    ).toBe('退款单 RF2 已通过审核，订单 SO2 没有需要退回的款项。');
    expect(body('refund_settled', { refundNo: 'RF2', refundNote: settledRefundNote('0') })).toBe(
      '退款单 RF2 已处理完成，没有需要退回的款项。',
    );
  });
});

describe('NOTIF-012 — a 退货退款 approval asks for the goods, not the money', () => {
  const body = (data: Record<string, string>) =>
    render(
      allNotificationEvents().find((event) => event.code === 'refund_approved')!.defaults.body,
      data,
    );

  it('asks a 退货退款 to send the goods back instead of announcing the money', () => {
    const note = approvedRefundNote('60.00', 'return_and_refund');
    expect(body({ refundNo: 'RF3', orderNo: 'SO3', refundNote: note })).toBe(
      '退款单 RF3 已通过审核，订单 SO3 的商品请寄回，地址见售后详情。',
    );
    // A ¥0 return still has goods to send back.
    expect(approvedRefundNote('0.00', 'return_and_refund')).toBe(note);
    // Mapped alone into a subscribe-message `thing`, it is not cut.
    expect([...note].length).toBeLessThanOrEqual(20);
  });
});
