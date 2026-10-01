import type { OrderListTab } from '@shop/contracts/order/schemas';

export type ShownTab = Exclude<OrderListTab, 'shipping' | 'refunding'>;

/**
 * The tabs, in the order the old page had them. 待评价 (`unreviewed`, ORDER-010) is the orders
 * with a line still to review, a subset of 已完成 (`finished`, received or completed); 售后 is
 * its own page (`refundList`), reached from 我的.
 */
export const ORDER_TABS: ReadonlyArray<{ key: ShownTab; label: string; counted: boolean }> = [
  { key: 'all', label: '全部', counted: false },
  { key: 'unpaid', label: '待付款', counted: true },
  { key: 'unshipped', label: '待发货', counted: true },
  { key: 'unreceived', label: '待收货', counted: true },
  { key: 'unreviewed', label: '待评价', counted: true },
  { key: 'finished', label: '已完成', counted: false },
  { key: 'cancelled', label: '已取消', counted: false },
];

export const EMPTY_TEXT: Record<ShownTab, string> = {
  all: '还没有订单',
  unpaid: '没有待付款的订单',
  unshipped: '没有待发货的订单',
  unreceived: '没有待收货的订单',
  unreviewed: '没有待评价的订单',
  finished: '没有已完成的订单',
  cancelled: '没有已取消的订单',
};

export function tabOf(value: string | undefined): ShownTab {
  return ORDER_TABS.find((tab) => tab.key === value)?.key ?? 'all';
}
