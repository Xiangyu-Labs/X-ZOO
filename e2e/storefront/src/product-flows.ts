import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';

import { payOrder } from './fixtures';
import type { Stack } from './stack';

/** Polls the real order-detail route until the payment has landed. */
export async function waitForOrderPaid(api: APIRequestContext, orderId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await api.get(`/api/v1/orders/${orderId}`);
    const body = (await response.json()) as { status: string };
    if (body.status !== 'pending_payment') return;
    if (Date.now() > deadline) throw new Error(`order ${orderId} never left pending_payment`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Arranges a paid order a journey needs to already exist, through the real
 * HTTP checkout API rather than the product-page UI — buying through the UI
 * is what the shopping journeys prove.
 */
export async function arrangePaidOrder(
  api: APIRequestContext,
  shop: Stack,
  options: {
    skuId: number;
    quantity?: number;
    addressId: number;
    kind?: 'normal' | 'groupbuy' | 'presale';
    kindMeta?: Record<string, unknown>;
  },
): Promise<{ id: string; orderNo: string }> {
  const created = await api.post('/api/v1/orders', {
    data: {
      source: 'buy-now',
      item: { skuId: String(options.skuId), quantity: options.quantity ?? 1 },
      addressId: String(options.addressId),
      kind: options.kind ?? 'normal',
      kindMeta: options.kindMeta,
      idempotencyKey: `e2e-${options.skuId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
  expect(created.ok(), `order create failed: ${created.status()} ${await created.text()}`).toBe(
    true,
  );
  const order = (await created.json()) as { id: string; orderNo: string };

  const paymentStart = await api.post(`/api/v1/orders/${order.id}/payments`, {
    data: { channel: 'wechat_h5', returnUrl: shop.baseUrl },
  });
  expect(
    paymentStart.ok(),
    `payment start failed: ${paymentStart.status()} ${await paymentStart.text()}`,
  ).toBe(true);
  const intent = (await paymentStart.json()) as { outTradeNo: string };
  await payOrder(shop, intent.outTradeNo);
  await waitForOrderPaid(api, order.id);

  return order;
}
