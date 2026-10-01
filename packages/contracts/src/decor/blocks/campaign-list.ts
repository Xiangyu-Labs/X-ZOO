import { z } from 'zod';

import { blockProps } from '../base';
import { CAMPAIGN_LIST_LAYOUTS, type CampaignListLayout } from '../constants';
import { ui } from '../meta';
import { defineBlock } from '../registry';
import { groupbuySource, need, presaleSource } from '../sources';
import { listHeading } from './list-heading';

const campaignLayout = z
  .enum(Object.keys(CAMPAIGN_LIST_LAYOUTS) as [CampaignListLayout, ...CampaignListLayout[]])
  .default('list')
  .meta(ui({ label: '排列方式', field: 'radio', options: CAMPAIGN_LIST_LAYOUTS, group: '展示' }));

/**
 * 拼团: group-buy campaigns visible now, picked by id or the latest `limit`
 * in the 拼团列表's order. Each card shows the 拼团价, the team size and how
 * many have been sold; a tap opens the campaign (`groupbuy { id }`).
 */
export const groupbuyListProps = blockProps({
  ...listHeading('拼团'),
  source: groupbuySource
    .default({ mode: 'auto', limit: 3 })
    .meta(ui({ label: '拼团活动', field: 'groupbuySource', group: '内容' })),
  layout: campaignLayout,
});
export type GroupbuyListProps = z.infer<typeof groupbuyListProps>;

export const groupbuyListBlock = defineBlock({
  type: 'groupbuyList',
  v: 1,
  props: groupbuyListProps,
  meta: { label: '拼团', pages: ['home', 'custom'] },
  data: (props) => ({ campaigns: need.groupbuys(props.source) }),
});

/**
 * 预售: presale campaigns inside their window, picked by id or the latest
 * `limit`. Each card shows the 预售价, the struck catalogue price, when it
 * ships, and a countdown to the end of the window driven by the server's
 * clock (the host passes `serverNow`). Presales are paid in full: the presale
 * domain refuses a 定金 campaign, so there is no deposit / balance to show.
 * A tap opens the campaign (`presale { id }`).
 */
export const presaleListProps = blockProps({
  ...listHeading('预售'),
  source: presaleSource
    .default({ mode: 'auto', limit: 3 })
    .meta(ui({ label: '预售活动', field: 'presaleSource', group: '内容' })),
  layout: campaignLayout,
  showCountdown: z
    .boolean()
    .default(true)
    .meta(ui({ label: '显示倒计时', group: '展示' })),
});
export type PresaleListProps = z.infer<typeof presaleListProps>;

export const presaleListBlock = defineBlock({
  type: 'presaleList',
  v: 1,
  props: presaleListProps,
  meta: { label: '预售', pages: ['home', 'custom'] },
  data: (props) => ({ campaigns: need.presales(props.source) }),
});
