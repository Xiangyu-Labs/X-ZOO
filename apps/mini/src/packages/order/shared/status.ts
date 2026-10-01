import type { OrderDetail } from '@shop/contracts/order/schemas';
import { awaitsReview } from '@/ui/order-actions';

/** The status header's title and the line under it on 订单详情. */
export function statusHeadline(
  order: Pick<
    OrderDetail,
    | 'status'
    | 'fulfillmentStatus'
    | 'hasOpenRefund'
    | 'cancelReason'
    | 'items'
    | 'groupbuyTeam'
    | 'paidAmount'
  >,
): { title: string; note: string | null } {
  const refunding = order.hasOpenRefund ? '售后处理中' : null;
  const team = order.groupbuyTeam;
  switch (order.status) {
    case 'pending_payment':
      return { title: '等待付款', note: null };
    case 'paid':
      // A 拼团 order ships once its team is complete (RISK-D-011), not before.
      if (team?.status === 'forming') {
        const left = Math.max(0, team.seatsTotal - team.seatsTaken);
        return {
          title: '拼团中',
          note: refunding ?? (left > 0 ? `还差 ${left} 人成团，成团后发货` : '成团后发货'),
        };
      }
      if (team?.status === 'failed' || team?.status === 'cancelled') {
        const charged = order.paidAmount !== null && Number(order.paidAmount) > 0;
        return {
          title: '未成团',
          note: charged ? '人数未凑齐，款项将原路退回' : '人数未凑齐，订单将关闭，没有产生扣款',
        };
      }
      return order.fulfillmentStatus === 'partially_fulfilled'
        ? { title: '部分发货', note: refunding ?? '其余商品正在准备中' }
        : { title: '等待发货', note: refunding ?? '商家正在准备商品，将以保密包装发出' };
    case 'shipped':
      return { title: '已发货', note: refunding ?? '收到商品后请确认收货' };
    case 'received':
      return {
        title: '已收货',
        note: refunding ?? (awaitsReview(order) ? '感谢购买，欢迎评价' : '感谢购买'),
      };
    case 'completed':
      return { title: '交易完成', note: refunding };
    case 'cancelled':
      return { title: '已取消', note: order.cancelReason };
    case 'refunded':
      return { title: '已退款', note: '款项已原路退回' };
  }
}
