import { View } from '@tarojs/components';

import type { GroupbuyListProps } from '@shop/contracts/decor/all-blocks';
import type { GroupbuySummary } from '@shop/contracts/decor/sources';
import { BlockFrame } from '../shared/frame';
import { ListHead, routeLink } from '../shared/list-head';
import type { BlockProps } from '../shared/types';
import { CampaignCards } from './campaign-cards';
import styles from './campaign-list.module.scss';

export interface CampaignListData<T> {
  campaigns?: readonly T[] | null | undefined;
}

/**
 * 拼团: running group-buy campaigns — the 拼团价, the team size (N人团) and
 * how many have been sold through it. A tap opens the campaign
 * (`groupbuy { id }`); joining a team happens there. Nothing running hides
 * the block, except in the editor.
 */
export function GroupbuyList({
  props,
  data,
  onLink,
  host,
}: BlockProps<GroupbuyListProps, CampaignListData<GroupbuySummary>>) {
  const campaigns = data?.campaigns ?? [];
  if (campaigns.length === 0 && !host?.canvas) return null;
  return (
    <BlockFrame type="groupbuyList" frame={props.style}>
      <ListHead
        title={props.title}
        more={props.showMore ? routeLink('groupbuyList') : undefined}
        onLink={onLink}
      />
      {campaigns.length === 0 ? (
        <View className={styles.empty}>暂无进行中的拼团，商城中不显示此组件</View>
      ) : (
        <CampaignCards
          layout={props.layout}
          resolveImage={host?.resolveImage}
          cards={campaigns.map((campaign) => ({
            id: campaign.activityId,
            title: campaign.title,
            imageUrl: campaign.imageUrl,
            price: campaign.price,
            originalPrice: campaign.originalPrice,
            badge: `${campaign.seatsRequired}人团`,
            priceLabel: '拼团价',
            note: campaign.sales > 0 ? `已拼 ${campaign.sales} 件` : '',
            action: '去拼团',
            onTap:
              onLink &&
              (() =>
                onLink({
                  kind: 'route',
                  to: { route: 'groupbuy', params: { id: campaign.activityId } },
                })),
          }))}
        />
      )}
    </BlockFrame>
  );
}
