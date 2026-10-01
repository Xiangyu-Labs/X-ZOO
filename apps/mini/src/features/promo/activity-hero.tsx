import { useState, type ReactNode } from 'react';
import { Swiper, SwiperItem, Text, View } from '@tarojs/components';
import { RichContent } from '@/features/content/rich-content';
import { assetUrl } from '@/lib/asset-url';
import { strikePrice } from '@/lib/money';
import { previewImages } from '@/platform';
import { Card } from '@/ui/card';
import { Countdown } from '@/ui/countdown';
import { Icon } from '@/ui/icon';
import { Image } from '@/ui/image';
import { Price } from '@/ui/price';
import { Pressable } from '@/ui/pressable';
import { Skeleton } from '@/ui/skeleton';
import { Tag } from '@/ui/tag';
import './activity-hero.scss';

export interface ActivityHeroProps {
  title: string;
  intro: string | null;
  imageUrl: string | null;
  sliderImages: readonly string[];
  price: string;
  originalPrice: string | null;
  /** 「2人团」「预售」. */
  badge: string;
  /** 「已拼 12 件」, or empty. */
  sales: string;
  /** The real deadline (C16), or `null` when there is none to count to. */
  deadline: { label: string; at: string } | null;
  /** The deadline passed: the page reads the activity again. */
  onDeadline: () => void;
  /** 分享 beside the title, when the page offers it. */
  onShare?: (() => void) | undefined;
  /** 「活动已结束」 over the picture. */
  overlay?: string | undefined;
}

/**
 * The top of a 拼团 / 预售 activity page: the pictures, the activity price with the list price
 * struck, the kind, the countdown to a real deadline, and the title.
 */
export function ActivityHero({
  title,
  intro,
  imageUrl,
  sliderImages,
  price,
  originalPrice,
  badge,
  sales,
  deadline,
  onDeadline,
  onShare,
  overlay,
}: ActivityHeroProps) {
  const [slide, setSlide] = useState(0);
  const strike = strikePrice(price, originalPrice);
  const sources = sliderImages.length > 0 ? sliderImages : [imageUrl];
  const urls = sources.map((src) => assetUrl(src)).filter((src): src is string => !!src);

  return (
    <>
      <View className="activity-hero__gallery">
        {urls.length > 0 ? (
          <Swiper
            className="activity-hero__swiper"
            circular={urls.length > 1}
            onChange={(event) => setSlide(event.detail.current)}
          >
            {urls.map((src, index) => (
              <SwiperItem key={src}>
                <Pressable
                  label={`查看大图，第 ${index + 1} 张`}
                  pressedTint={false}
                  onClick={() => previewImages(urls, src)}
                >
                  <Image src={src} label={index === 0 ? title : undefined} lazy={false} />
                </Pressable>
              </SwiperItem>
            ))}
          </Swiper>
        ) : (
          <Image src={null} label={title} />
        )}
        {urls.length > 1 ? (
          <Text className="activity-hero__counter">
            {slide + 1}/{urls.length}
          </Text>
        ) : null}
        {overlay ? <Text className="activity-hero__overlay">{overlay}</Text> : null}
      </View>

      <View className="activity-hero__band">
        <View className="activity-hero__price">
          <Tag tone="primary">{badge}</Tag>
          <Price value={price} size="lg" />
          {strike ? <Price value={strike} size="sm" strike /> : null}
        </View>
        {deadline ? (
          <View className="activity-hero__deadline">
            <Text className="activity-hero__deadline-label">{deadline.label}</Text>
            <Countdown endsAt={deadline.at} format="dhms" variant="boxed" onEnd={onDeadline} />
          </View>
        ) : null}
      </View>

      <View className="activity-hero__summary">
        <View className="activity-hero__title-row">
          <Text className="activity-hero__title" id="activity-title" userSelect>
            {title}
          </Text>
          {onShare ? (
            <Pressable label="分享" className="activity-hero__share" onClick={onShare}>
              <Icon name="share" />
              <Text className="activity-hero__share-text">分享</Text>
            </Pressable>
          ) : null}
        </View>
        {intro ? <Text className="activity-hero__intro">{intro}</Text> : null}
        {sales ? <Text className="activity-hero__sales">{sales}</Text> : null}
      </View>
    </>
  );
}

/** 商品详情 under an activity: the description through the 富文本 block, as on 商品详情. */
export function ActivityDescription({ html }: { html: string | null }) {
  return (
    <Card title="商品详情" className="activity-hero__description" id="activity-description">
      {html?.trim() ? (
        <RichContent html={html} />
      ) : (
        <Text className="activity-hero__muted">暂无图文详情</Text>
      )}
    </Card>
  );
}

/** A titled block of plain lines: 拼团规则, 发货说明. */
export function ActivityNotes({
  title,
  lines,
  id,
  children,
}: {
  title: string;
  lines: readonly string[];
  id?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <Card title={title} className="activity-hero__notes" id={id}>
      {lines.map((line) => (
        <Text key={line} className="activity-hero__note">
          {line}
        </Text>
      ))}
      {children}
    </Card>
  );
}

export function ActivitySkeleton() {
  return (
    <View className="activity-hero__skeleton">
      <Skeleton className="activity-hero__skeleton-image" />
      <View className="activity-hero__summary">
        <Skeleton width="40%" />
        <Skeleton width="90%" />
        <Skeleton width="60%" />
      </View>
    </View>
  );
}
