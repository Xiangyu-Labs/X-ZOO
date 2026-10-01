import { Text, View } from '@tarojs/components';
import type { ResponseOf } from '@shop/api-client';
import { assetUrl } from '@/lib/asset-url';
import { formatDate } from '@/lib/format';
import { formatSpec } from '@/lib/spec';
import { previewImages } from '@/platform';
import { Icon } from '@/ui/icon';
import { Image } from '@/ui/image';
import { Pressable } from '@/ui/pressable';
import './review-item.scss';

export type Review = ResponseOf<'catalog.productReviews'>['items'][number];

/** 「4 星」 as five stars, for eyes; the number for screen readers. */
export function Stars({ score }: { score: number }) {
  return (
    <View className="shop-stars" ariaRole="img" ariaLabel={`${score} 星`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Icon
          key={n}
          name={n <= score ? 'star-fill' : 'star'}
          className={n <= score ? 'shop-stars__on' : 'shop-stars__off'}
        />
      ))}
    </View>
  );
}

/**
 * One review (商品详情's first reviews, 商品评价's list): who, stars, spec, date, text, up to
 * nine pictures (tap to preview) and the shop's reply.
 */
export function ReviewItem({ review, clamp = false }: { review: Review; clamp?: boolean }) {
  const images = review.images.map((src) => assetUrl(src)).filter((src): src is string => !!src);
  return (
    <View className="shop-review">
      <View className="shop-review__head">
        <View className="shop-review__avatar">
          <Image
            src={assetUrl(review.authorAvatarUrl)}
            radius="none"
            size="small"
            placeholder="user"
          />
        </View>
        <View className="shop-review__who">
          <Text className="shop-review__name">{review.authorNickname || '匿名用户'}</Text>
          <Stars score={review.productScore} />
        </View>
        <Text className="shop-review__date">{formatDate(review.createdAt)}</Text>
      </View>
      {review.specText ? (
        <Text className="shop-review__spec">规格：{formatSpec(review.specText)}</Text>
      ) : null}
      <Text
        className={
          clamp ? 'shop-review__content shop-review__content--clamp' : 'shop-review__content'
        }
      >
        {review.content || '用户没有填写评价内容'}
      </Text>
      {images.length > 0 ? (
        <View className="shop-review__images">
          {images.slice(0, 9).map((src, index) => (
            <Pressable
              key={src}
              label={`查看第 ${index + 1} 张图片`}
              className="shop-review__image"
              onClick={() => previewImages(images, src)}
            >
              <Image src={src} radius="sm" size="small" />
            </Pressable>
          ))}
        </View>
      ) : null}
      {review.replyContent ? (
        <Text className="shop-review__reply">商家回复：{review.replyContent}</Text>
      ) : null}
    </View>
  );
}
