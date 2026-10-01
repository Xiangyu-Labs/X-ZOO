import { toCents } from '@/lib/money';
import type { RefundableItem, RefundKind, RefundListItem } from '@shop/contracts/refund/schemas';

export { fromCents, toCents } from '@/lib/money';

/**
 * What one line would give back for `quantity` units: all of its `refundableAmount` when every
 * remaining unit goes, else that amount's share, rounded down. Only an estimate: the server
 * computes the real amount (`refund.apply` takes no amount).
 */
export function lineEstimate(item: RefundableItem, quantity: number): number {
  if (item.refundableQuantity <= 0 || quantity <= 0) return 0;
  const all = toCents(item.refundableAmount);
  if (quantity >= item.refundableQuantity) return all;
  return Math.floor((all * quantity) / item.refundableQuantity);
}

export const KIND_TEXT: Record<RefundKind, string> = {
  refund_only: '仅退款',
  return_and_refund: '退货退款',
};

/** The shopper's words for where a request stands. */
export function refundStatusText(
  refund: Pick<RefundListItem, 'status' | 'kind' | 'returnStage'>,
): string {
  switch (refund.status) {
    case 'applied':
      return '待商家处理';
    case 'approved':
      if (refund.kind === 'return_and_refund') {
        if (refund.returnStage === 'awaiting_shipment') return '待寄回商品';
        if (refund.returnStage === 'shipped_back') return '待商家收货';
      }
      return '退款处理中';
    case 'processing':
    case 'unknown':
      return '退款处理中';
    // The merchant can still retry it: in progress, not closed (REFUND-017).
    case 'failed':
      return '退款处理中';
    case 'succeeded':
      return '退款成功';
    case 'rejected':
      return '商家已拒绝';
    case 'cancelled':
      return '已撤销';
  }
}

/**
 * 撤销申请: only while no money can have moved (`applied`, `approved`, `failed`), and never for a
 * refund the shop opened itself — the server's `buyerMayWithdraw`.
 */
export function canCancel(refund: Pick<RefundListItem, 'status' | 'isAutomatic'>): boolean {
  if (refund.isAutomatic) return false;
  return refund.status === 'applied' || refund.status === 'approved' || refund.status === 'failed';
}

/** 填写退货物流: an approved return still waiting for the parcel. */
export function awaitsReturn(
  refund: Pick<RefundListItem, 'status' | 'kind' | 'returnStage'>,
): boolean {
  return (
    refund.status === 'approved' &&
    refund.kind === 'return_and_refund' &&
    refund.returnStage === 'awaiting_shipment'
  );
}

/** 删除记录: only a finished request leaves the list — not a failed one the merchant can retry. */
export function canHide(refund: Pick<RefundListItem, 'status'>): boolean {
  return ['rejected', 'succeeded', 'cancelled'].includes(refund.status);
}
