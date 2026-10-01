import type { ApiClient, ResponseOf } from '@shop/api-client';
import { errorMessage } from '@/lib/error-message';
import { showModal } from './feedback';
import { onAppShown, type AppShowOptions } from './lifecycle';
import { platform } from './runtime';
import type { OrderConfirmOutcome, OrderConfirmTarget } from './types';

/**
 * 确认收货 (C07). The one place that calls `order.confirmReceipt` (a guard holds it).
 *
 * A mini-program payment that WeChat's 发货信息管理 covers is confirmed in WeChat's own
 * component (`openBusinessView`), which releases the frozen funds; the server then checks with
 * WeChat before the order moves. Every other order (paid elsewhere, or not covered) gets the
 * plain 「确认收货？」 dialog and the plain call.
 *
 * The client is a parameter, not `@/data/api`, because that module imports `@/platform`.
 * Call it from the tap: the component, like the dialog, must follow a user gesture.
 *
 * WeChat does not always call back when the shopper leaves its component (C07 asks for a
 * fallback in `App.onShow`): while the component is open a pending-receipt marker listens for
 * the app coming back. `referrerInfo.extraData.status` settles it as the callback would; a
 * return without one waits `RETURN_GRACE_MS` for a late callback, then asks the server, which
 * checks with WeChat (`get_order`) before it moves the order. Either way the caller re-reads
 * the order: `returned` means "not confirmed as far as anyone can tell, show what is true now".
 */
export type ReceiptOutcome =
  | { kind: 'confirmed'; order: ResponseOf<'order.confirmReceipt'> }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string }
  | { kind: 'returned' };

/** How long a return without an answer waits for the component's own callback. */
export const RETURN_GRACE_MS = 1500;

/**
 * What WeChat's component needs for this order, or `null` for the plain dialog. The server
 * decides (`payment.wechatReceipt`): the order is the shopper's own, was paid in the mini
 * program, and WeChat has been told it is all out.
 */
async function wechatTarget(
  client: ApiClient,
  orderId: string,
): Promise<OrderConfirmTarget | null> {
  const { receipt } = await client.call('payment.wechatReceipt', { params: { id: orderId } });
  return receipt;
}

function messageOf(error: unknown): string {
  return errorMessage(error, '确认收货失败，请稍后重试');
}

type ComponentAnswer = OrderConfirmOutcome | { kind: 'returned' };

/** `referrerInfo.extraData.status` as the component's own answer, if WeChat passed one. */
function answerOf(options: AppShowOptions): OrderConfirmOutcome | null {
  const status = options.referrerInfo?.extraData?.['status'];
  if (status === 'success') return { kind: 'confirmed' };
  if (status === 'cancel') return { kind: 'cancelled' };
  if (status === 'fail') return { kind: 'failed', message: '微信确认收货未完成' };
  return null;
}

/**
 * Opens the component and settles on whichever comes first: its callback, or the app coming
 * back (with an answer at once, without one after the grace period). The listener lives only
 * while the component is open.
 */
function openComponent(target: OrderConfirmTarget): Promise<ComponentAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let stop = (): void => undefined;
    const settle = (answer: ComponentAnswer) => {
      if (settled) return;
      settled = true;
      if (grace !== undefined) clearTimeout(grace);
      stop();
      resolve(answer);
    };
    stop = onAppShown((options) => {
      const answer = answerOf(options);
      if (answer) settle(answer);
      else grace ??= setTimeout(() => settle({ kind: 'returned' }), RETURN_GRACE_MS);
    });
    platform
      .openOrderConfirm(target)
      .then(settle, (error: unknown) => settle({ kind: 'failed', message: messageOf(error) }));
  });
}

async function post(
  client: ApiClient,
  orderId: string,
  viaComponent: boolean,
): Promise<ReceiptOutcome> {
  try {
    const order = await client.call('order.confirmReceipt', {
      params: { id: orderId },
      // The server asks WeChat before it believes the component (C07).
      body: viaComponent ? { via: 'wechat-component' } : {},
    });
    return { kind: 'confirmed', order };
  } catch (error) {
    return { kind: 'failed', message: messageOf(error) };
  }
}

export async function confirmReceipt(client: ApiClient, orderId: string): Promise<ReceiptOutcome> {
  let target: OrderConfirmTarget | null;
  try {
    target = await wechatTarget(client, orderId);
  } catch (error) {
    return { kind: 'failed', message: messageOf(error) };
  }

  if (!target) {
    const ok = await showModal({
      title: '确认收货',
      content: '请确认已收到全部商品。确认后订单完成，可以评价。',
      confirmText: '确认收货',
    });
    return ok ? post(client, orderId, false) : { kind: 'cancelled' };
  }

  const answer = await openComponent(target);
  // `cancel`: the shopper closed WeChat's page; nothing happened. `fail`: say so, the button
  // stays for another try.
  if (answer.kind === 'cancelled' || answer.kind === 'failed') return answer;
  const outcome = await post(client, orderId, true);
  // Back without an answer: the server's word (from WeChat) or nothing; no error to show.
  if (answer.kind === 'returned' && outcome.kind === 'failed') return { kind: 'returned' };
  return outcome;
}
