import { ScrollView, Text, View } from '@tarojs/components';
import type { ReactNode } from 'react';

import type { CampaignListLayout } from '@shop/contracts/decor/constants';
import { BlockImage } from '../shared/block-image';
import { cx, tapProps } from '../shared/css';
import type { ImageResolver } from '../shared/types';
import { splitPrice } from '../product-grid/product-cards';
import styles from './campaign-cards.module.scss';

export interface CampaignCard {
  id: string;
  title: string;
  imageUrl: string | null;
  price: string;
  originalPrice: string | null;
  /** Small badge over the picture: 2人团. */
  badge?: string | undefined;
  /** The label before the price: 拼团价 / 预售价. */
  priceLabel: string;
  /** One quiet line under the price: 已拼 12 件 / 付款后 7 天内发货. */
  note: string;
  /** An extra line (the 预售 countdown). */
  extra?: ReactNode;
  action: string;
  onTap?: (() => void) | undefined;
}

/**
 * The cards of 拼团 and 预售: a one-column list (picture left) or a sideways
 * row. The same price treatment as the product cards (smaller ¥ and fen,
 * design.md §price), struck reference price only when higher.
 */
export function CampaignCards({
  cards,
  layout,
  resolveImage,
}: {
  cards: readonly CampaignCard[];
  layout: CampaignListLayout;
  /** The host's picture resolver (`BlockHost.resolveImage`). */
  resolveImage?: ImageResolver | undefined;
}) {
  const items = cards.map((card) => {
    const [yuan, fen] = splitPrice(card.price);
    const struck =
      card.originalPrice !== null && Number(card.originalPrice) > Number(card.price)
        ? card.originalPrice
        : null;
    return (
      <View key={card.id} className={styles.card} data-campaign={card.id} {...tapProps(card.onTap)}>
        <View className={styles.media}>
          {card.imageUrl ? (
            <BlockImage
              className={styles.image}
              src={card.imageUrl}
              width={480}
              resolve={resolveImage}
              mode="aspectFill"
              lazyLoad
            />
          ) : null}
          {card.badge ? <Text className={styles.badge}>{card.badge}</Text> : null}
        </View>
        <View className={styles.body}>
          <View className={styles.title}>{card.title}</View>
          {card.extra ?? null}
          <View className={styles.bottom}>
            <View className={styles.prices}>
              <Text className={styles.priceLabel}>{card.priceLabel}</Text>
              <Text className={styles.price}>
                <Text className={styles.minor}>¥</Text>
                {yuan}
                <Text className={styles.minor}>{fen}</Text>
              </Text>
              {struck ? <Text className={styles.struck}>¥{struck}</Text> : null}
            </View>
            <View className={styles.foot}>
              <Text className={styles.note}>{card.note}</Text>
              <View className={styles.button}>{card.action}</View>
            </View>
          </View>
        </View>
      </View>
    );
  });
  if (layout === 'scroll') {
    return (
      <ScrollView className={cx(styles.cards, styles.scroll)} scrollX enableFlex>
        <View className={styles.track}>{items}</View>
      </ScrollView>
    );
  }
  return <View className={cx(styles.cards, styles.list)}>{items}</View>;
}
