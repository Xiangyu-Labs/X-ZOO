import { Text, View } from '@tarojs/components';
import { useEffect, useState } from 'react';

import type { PresaleListProps } from '@shop/contracts/decor/all-blocks';
import type { PresaleSummary } from '@shop/contracts/decor/sources';
import { BlockFrame } from '../shared/frame';
import { ListHead, routeLink } from '../shared/list-head';
import { campaignPhase, formatMoment, formatRemaining } from '../shared/time';
import type { BlockProps } from '../shared/types';
import { CampaignCards } from './campaign-cards';
import type { CampaignListData } from './groupbuy-list';
import styles from './campaign-list.module.scss';

/**
 * The server's clock, re-read every second while `serverNow` is given and
 * `active` (counting, and the page on screen). One interval per block, however
 * many cards it has; none at all without a clock (the cards then show the end
 * time, not a countdown). Shown again, it reads the clock at once.
 */
function useTicking(serverNow: (() => number) | undefined, active: boolean): number | null {
  const [now, setNow] = useState<number | null>(() => (serverNow ? serverNow() : null));
  useEffect(() => {
    if (!serverNow || !active) return undefined;
    setNow(serverNow());
    const timer = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(timer);
  }, [serverNow, active]);
  return serverNow ? now : null;
}

/** 距结束 2天 03:04:05 · 距开始 … · 已结束; or, without a clock, 05月31日 20:00 结束. */
export function presaleCountdown(
  campaign: Pick<PresaleSummary, 'startAt' | 'endAt'>,
  now: number | null,
): string {
  if (now === null) return `${formatMoment(campaign.endAt)} 结束`;
  const phase = campaignPhase(campaign.startAt, campaign.endAt, now);
  if (phase.phase === 'ended') return '已结束';
  return `${phase.phase === 'upcoming' ? '距开始' : '距结束'} ${formatRemaining(phase.until - now)}`;
}

/**
 * 预售: presale campaigns in their window — the 预售价 with the struck
 * catalogue price, when it ships, and the time left, counted on the server's
 * clock (`host.serverNow`), never the device's. Presales are paid in full
 * (the domain refuses a 定金 campaign), so there is no deposit / balance line.
 * A tap opens the campaign (`presale { id }`).
 */
export function PresaleList({
  props,
  data,
  onLink,
  host,
}: BlockProps<PresaleListProps, CampaignListData<PresaleSummary>>) {
  const campaigns = data?.campaigns ?? [];
  const now = useTicking(
    host?.serverNow,
    props.showCountdown && campaigns.length > 0 && host?.hidden !== true,
  );
  if (campaigns.length === 0 && !host?.canvas) return null;
  return (
    <BlockFrame type="presaleList" frame={props.style}>
      <ListHead
        title={props.title}
        more={props.showMore ? routeLink('presaleList') : undefined}
        onLink={onLink}
      />
      {campaigns.length === 0 ? (
        <View className={styles.empty}>暂无进行中的预售，商城中不显示此组件</View>
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
            badge: '预售',
            priceLabel: '预售价',
            note:
              campaign.shipAfterDays > 0
                ? `付款后 ${campaign.shipAfterDays} 天内发货`
                : '付款后尽快发货',
            extra: props.showCountdown ? (
              <Text className={styles.countdown} data-countdown={campaign.activityId}>
                {presaleCountdown(campaign, now)}
              </Text>
            ) : undefined,
            action: '去预订',
            onTap:
              onLink &&
              (() =>
                onLink({
                  kind: 'route',
                  to: { route: 'presale', params: { id: campaign.activityId } },
                })),
          }))}
        />
      )}
    </BlockFrame>
  );
}
