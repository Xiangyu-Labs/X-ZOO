import { Text, View } from '@tarojs/components';
import type { ResponseOf } from '@shop/api-client';
import { useInfiniteRouteQuery } from '@shop/api-client/react';
import { assetUrl } from '@/lib/asset-url';
import { formatDate } from '@/lib/format';
import { navigate, previewImages } from '@/platform';
import { LoginGate } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Empty } from '@/ui/empty';
import { Icon } from '@/ui/icon';
import { Image } from '@/ui/image';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import { CellSkeleton } from '@/ui/skeleton';
import { Tag } from '@/ui/tag';
import './index.scss';

type MyReview = ResponseOf<'catalog.myReviews'>['items'][number];

/**
 * What a review that is not public says. Neutral on purpose (C09): a review held by 评价审核
 * or by WeChat's content check is never shown as an error or a verdict.
 */
export const REVIEW_STATE_TEXT: Readonly<Record<MyReview['status'], string | null>> = {
  published: null,
  pending: '审核后展示',
  hidden: '仅自己可见',
};

/**
 * 我的评价 (`myReviews`, pages.md §2.6): the shopper's own reviews, newest first, with the
 * shop's reply. A tap on the product opens it; pictures open in the viewer.
 */
export default function MyReviewsPage() {
  return (
    <PageShell title="我的评价">
      <LoginGate reason="登录后可以查看写过的评价" redirect={{ route: 'myReviews', params: {} }}>
        <Reviews />
      </LoginGate>
    </PageShell>
  );
}

function Reviews() {
  const signedIn = useSignedIn();
  const list = useInfiniteRouteQuery(
    'catalog.myReviews',
    { query: { pageSize: 20 } },
    { enabled: signedIn },
  );
  return (
    <View className="account-page">
      <InfiniteList
        query={list}
        itemKey={(review) => review.id}
        skeleton={<CellSkeleton rows={4} />}
        empty={<Empty title="还没有评价" description="确认收货后，可以在订单里写评价" />}
        renderItem={(review) => <ReviewCard review={review} />}
      />
    </View>
  );
}

function Stars({ score }: { score: number }) {
  return (
    <View className="my-review__stars" ariaLabel={`${score} 星`} ariaRole="img">
      {[1, 2, 3, 4, 5].map((n) => (
        <Icon
          key={n}
          name={n <= score ? 'star-fill' : 'star'}
          className={n <= score ? 'my-review__star my-review__star--on' : 'my-review__star'}
        />
      ))}
    </View>
  );
}

function ReviewCard({ review }: { review: MyReview }) {
  const state = REVIEW_STATE_TEXT[review.status];
  const images = review.images.map((url) => assetUrl(url) ?? url);
  return (
    <View className="my-review">
      <Pressable
        label={review.productName}
        role="link"
        className="my-review__product"
        onClick={() => navigate({ route: 'product', params: { id: review.productId } })}
      >
        <View className="my-review__thumb">
          <Image src={assetUrl(review.productImageUrl)} ratio={1} radius="sm" size="small" />
        </View>
        <View className="my-review__product-text">
          <Text className="my-review__name">{review.productName}</Text>
          {review.specText ? <Text className="my-review__spec">{review.specText}</Text> : null}
        </View>
        <Icon name="chevron-right" className="my-review__arrow" />
      </Pressable>
      <View className="my-review__head">
        <Stars score={review.productScore} />
        <Text className="my-review__date">{formatDate(review.createdAt)}</Text>
        {state ? (
          <Tag tone="neutral" size="sm">
            {state}
          </Tag>
        ) : null}
      </View>
      {review.content ? <Text className="my-review__content">{review.content}</Text> : null}
      {images.length > 0 ? (
        <View className="my-review__images">
          {images.map((url, index) => (
            <Pressable
              key={url}
              label={`查看第 ${index + 1} 张图片`}
              className="my-review__image"
              onClick={() => previewImages(images, url)}
            >
              <Image src={url} ratio={1} radius="sm" size="small" />
            </Pressable>
          ))}
        </View>
      ) : null}
      {review.replyContent ? (
        <View className="my-review__reply">
          <Text className="my-review__reply-label">商家回复：</Text>
          <Text>{review.replyContent}</Text>
        </View>
      ) : null}
    </View>
  );
}
