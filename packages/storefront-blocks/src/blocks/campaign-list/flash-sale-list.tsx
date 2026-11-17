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
 * device's — and, with 显示即将开始的秒杀, the ones not started yet: 距开始 and a
 * greyed 即将开始 instead of 去抢购, turning into a live card at the start. The
 * cards are the 预售 block's, with 秒杀 words. A tap opens the product page,
 * which shows the 秒杀 and sells at its price; 「更多」 opens the 秒杀 list page
 * (`flashSaleList`).
 */
export function FlashSaleList({
  props,
  data,
  onLink,
  host,
}: BlockProps<FlashSaleListProps, CampaignListData<FlashSaleSummary>>) {
  const campaigns = data?.campaigns ?? [];
  const anyUpcoming = campaigns.some((campaign) => notStarted(campaign, host?.serverNow?.()));
  const now = useTicking(
    host?.serverNow,
    (props.showCountdown || anyUpcoming) && campaigns.length > 0 && host?.hidden !== true,
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
        <View className={styles.empty}>
          {props.showUpcoming
            ? '暂无进行中或即将开始的秒杀，商城中不显示此组件'
            : '暂无进行中的秒杀，商城中不显示此组件'}
        </View>
      ) : (
        <CampaignCards
          layout={props.layout}
          resolveImage={host?.resolveImage}
          cards={campaigns.map((campaign) => {
            const upcoming = notStarted(campaign, now ?? undefined);
            return {
              id: campaign.activityId,
              title: campaign.title,
              imageUrl: campaign.imageUrl,
              price: campaign.price,
              originalPrice: campaign.originalPrice,
              badge: '秒杀',
              priceLabel: '秒杀价',
              note: campaign.canBuy || upcoming ? '' : '已抢光',
              extra: props.showCountdown ? (
                <Text className={styles.countdown} data-countdown={campaign.activityId}>
                  {presaleCountdown(campaign, now)}
                </Text>
              ) : undefined,
              action: upcoming ? '即将开始' : '去抢购',
              actionMuted: upcoming,
              onTap:
                onLink &&
                (() =>
                  onLink({
                    kind: 'route',
                    to: { route: 'product', params: { id: campaign.productId } },
                  })),
            };
          })}
        />
      )}
    </BlockFrame>
  );
}

/**
 * Not started yet, on the server's clock; with no clock (a test, a host
 * without one), on the device's — only to pick the button's words.
 */
function notStarted(campaign: Pick<FlashSaleSummary, 'startAt'>, now: number | undefined): boolean {
  return Date.parse(campaign.startAt) > (now ?? Date.now());
}
