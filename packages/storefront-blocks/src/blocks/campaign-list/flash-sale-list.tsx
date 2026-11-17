import { Text, View } from '@tarojs/components';

import type { FlashSaleListProps } from '@shop/contracts/decor/all-blocks';
import type { FlashSaleSummary } from '@shop/contracts/decor/sources';
import { BlockFrame } from '../shared/frame';
import { ListHead, routeLink } from '../shared/list-head';
import type { BlockProps } from '../shared/types';
import { CampaignCards } from './campaign-cards';
import type { CampaignListData } from './groupbuy-list';
import { presaleCountdown, useTicking } from './presale-list';
import styles from './campaign-list.module.scss';

/**
 * 限时秒杀: products on 秒杀 now — the 秒杀价 with the struck own price and the
 * time left, counted on the server's clock (`host.serverNow`), never the
 * device's. The cards are the 预售 block's, with 秒杀 words. A tap opens the
 * product page, which shows the 秒杀 and sells at its price; 「更多」 opens the
 * 秒杀 list page (`flashSaleList`).
 */
export function FlashSaleList({
  props,
  data,
  onLink,
  host,
}: BlockProps<FlashSaleListProps, CampaignListData<FlashSaleSummary>>) {
  const campaigns = data?.campaigns ?? [];
  const now = useTicking(
    host?.serverNow,
    props.showCountdown && campaigns.length > 0 && host?.hidden !== true,
  );
  if (campaigns.length === 0 && !host?.canvas) return null;
  return (
    <BlockFrame type="flashSaleList" frame={props.style}>
      <ListHead
        title={props.title}
        more={props.showMore ? routeLink('flashSaleList') : undefined}
        onLink={onLink}
      />
      {campaigns.length === 0 ? (
        <View className={styles.empty}>暂无进行中的秒杀，商城中不显示此组件</View>
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
            badge: '秒杀',
            priceLabel: '秒杀价',
            note: campaign.canBuy ? '' : '已抢光',
            extra: props.showCountdown ? (
              <Text className={styles.countdown} data-countdown={campaign.activityId}>
                {presaleCountdown(campaign, now)}
              </Text>
            ) : undefined,
            action: '去抢购',
            onTap:
              onLink &&
              (() =>
                onLink({
                  kind: 'route',
                  to: { route: 'product', params: { id: campaign.productId } },
                })),
          }))}
        />
      )}
    </BlockFrame>
  );
}
