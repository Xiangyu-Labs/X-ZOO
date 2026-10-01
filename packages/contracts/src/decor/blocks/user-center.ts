import { z } from 'zod';

import { blockProps, imageUrl } from '../base';
import { ORDER_ENTRY_KEYS, type OrderEntryKey } from '../constants';
import { linkTarget } from '../link';
import { ui } from '../meta';
import { defineBlock } from '../registry';
import { personalNeed } from '../sources';

/**
 * The 个人中心 blocks (plan §2.2): 用户卡片, 订单入口, 服务宫格.
 *
 * Their props are configuration only. The shopper's own data — nickname,
 * avatar, the coupon / favourite / history totals, order counts — is never
 * page data: the blocks declare it with `personal`, and the resolver answers
 * it only with a session, beside the page, never cached (DECOR-015). The
 * cached page stays free of anything personal.
 */

export const userCardProps = blockProps({
  background: imageUrl.optional().meta(ui({ label: '背景图', field: 'image', group: '内容' })),
  /** 优惠券 / 收藏 / 足迹 counters under the name. */
  showStats: z
    .boolean()
    .default(true)
    .meta(ui({ label: '显示券、收藏、足迹数量', group: '内容' })),
});
export type UserCardProps = z.infer<typeof userCardProps>;

export const userCardBlock = defineBlock({
  type: 'userCard',
  v: 1,
  props: userCardProps,
  meta: { label: '用户卡片', pages: ['user_center'], maxPerPage: 1 },
  personal: (props) => ({ user: personalNeed.userSummary(props.showStats) }),
});

const orderEntryKey = z.enum(Object.keys(ORDER_ENTRY_KEYS) as [OrderEntryKey, ...OrderEntryKey[]]);

export const orderEntryItem = z.object({
  key: orderEntryKey.meta(ui({ label: '入口', options: ORDER_ENTRY_KEYS })),
  label: z
    .string()
    .min(1)
    .max(6)
    .meta(ui({ label: '文字' })),
  icon: imageUrl.optional().meta(ui({ label: '图标（不选用默认）', field: 'image' })),
});
export type OrderEntryItem = z.infer<typeof orderEntryItem>;

export const orderEntryProps = blockProps({
  title: z
    .string()
    .min(1)
    .max(10)
    .default('我的订单')
    .meta(ui({ label: '标题', group: '内容' })),
  items: z
    .array(orderEntryItem)
    .min(1)
    .max(5)
    .default([
      { key: 'unpaid', label: '待付款' },
      { key: 'unshipped', label: '待发货' },
      { key: 'unreceived', label: '待收货' },
      { key: 'unreviewed', label: '待评价' },
      { key: 'aftersale', label: '售后/退款' },
    ])
    .meta(ui({ label: '入口', field: 'array', itemLabel: 'label', group: '内容' })),
});
export type OrderEntryProps = z.infer<typeof orderEntryProps>;

export const orderEntryBlock = defineBlock({
  type: 'orderEntry',
  v: 1,
  props: orderEntryProps,
  meta: { label: '订单入口', pages: ['user_center'], maxPerPage: 1 },
  personal: () => ({ counts: personalNeed.orderCounts() }),
});

/**
 * What a 服务 entry does: open a link, or start a 客服 conversation. `contact`
 * cannot be a link — in WeChat it is `<button open-type="contact">`, a native
 * control. The block only says so (an intent); the mini-program draws the
 * button, and a client without one (H5) falls back to its own 客服 route.
 */
export const SERVICE_ACTIONS = { link: '打开链接', contact: '联系客服' } as const;
export type ServiceAction = keyof typeof SERVICE_ACTIONS;

/**
 * Added `action` without a version bump: it is additive with a default, so
 * every stored v1 item still parses to the same thing (`action: 'link'`).
 */
export const serviceGridItem = z
  .object({
    label: z
      .string()
      .min(1)
      .max(8)
      .meta(ui({ label: '文字' })),
    icon: imageUrl.optional().meta(ui({ label: '图标（不选用默认）', field: 'image' })),
    action: z
      .enum(Object.keys(SERVICE_ACTIONS) as [ServiceAction, ...ServiceAction[]])
      .default('link')
      .meta(ui({ label: '点击后', field: 'radio', options: SERVICE_ACTIONS })),
    link: linkTarget.optional().meta(ui({ label: '跳转链接（联系客服时不用填）', field: 'link' })),
  })
  .refine((item) => item.action !== 'link' || item.link !== undefined, {
    message: '请选择跳转链接',
    path: ['link'],
  });
export type ServiceGridItem = z.infer<typeof serviceGridItem>;

export const serviceGridProps = blockProps({
  title: z
    .string()
    .max(10)
    .default('我的服务')
    .meta(ui({ label: '标题（留空不显示）', group: '内容' })),
  columns: z
    .union([z.literal(4), z.literal(5)])
    .default(4)
    .meta(
      ui({ label: '每行个数', field: 'radio', options: { 4: '4 个', 5: '5 个' }, group: '内容' }),
    ),
  items: z
    .array(serviceGridItem)
    .min(1)
    .max(20)
    .meta(ui({ label: '服务', field: 'array', itemLabel: 'label', group: '内容' })),
});
export type ServiceGridProps = z.infer<typeof serviceGridProps>;

export const serviceGridBlock = defineBlock({
  type: 'serviceGrid',
  v: 1,
  props: serviceGridProps,
  meta: { label: '服务宫格', pages: ['user_center', 'custom'] },
});
