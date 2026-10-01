import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Text, View } from '@tarojs/components';
import type { OrderDetail, StorefrontOrderItem } from '@shop/contracts/order/schemas';
import { isApiError } from '@shop/api-client';
import { useApiClient, useInvalidateRoutes, useRouteQuery } from '@shop/api-client/react';
import { goBack, leaveFor, useRouteParams } from '@/platform';
import { LoginCard } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { toast } from '@/ui/feedback';
import { Textarea } from '@/ui/field';
import { Icon } from '@/ui/icon';
import { ImageUploader } from '@/ui/image-uploader';
import { OrderItemRow } from '@/ui/order-card';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import { Result } from '@/ui/result';
import { CellSkeleton } from '@/ui/skeleton';
import { DECOR_PAGE_READS, markStale } from '@/data/stale-reads';
import { ORDER_READS } from '../shared/actions';
import './index.scss';
import { errorMessage } from '@/lib/error-message';

/** What the server said of a line's review. `already`: written before (this page or another). */
export type LineOutcome = 'published' | 'pending' | 'already';

interface Draft {
  productScore: number;
  content: string;
  images: string[];
}

const SCORE_WORDS = ['', '非常差', '差', '一般', '好', '非常好'];
const MAX_TEXT = 500;

/**
 * The lines this page shows: those a review can be written for now (`reviewable`, ORDER-010:
 * the order received, the line not all refunded, no review yet) and those already reviewed,
 * shown as done.
 */
export function reviewLines(order: OrderDetail, only?: string): StorefrontOrderItem[] {
  return order.items.filter(
    (item) => (item.reviewable || item.reviewed) && (only === undefined || item.id === only),
  );
}

/**
 * 评价商品 (`reviewWrite`, `packages/order/review/index?orderId=&orderItemId=`). One card per
 * bought line (stars, words, up to 9 pictures) and one 服务评分 for the order, sent line by
 * line. A review the shop has to look at first (评价需审核, or WeChat's 内容安全, C09) is not an
 * error: the page says 「评价已提交，审核后展示」 either way.
 *
 * No 匿名 switch: the server keeps no nickname or avatar on a review (`authorNickname` is
 * always `null` for a shopper's own), so every review already shows without one; the page
 * says so.
 */
export default function ReviewPage() {
  const { orderId = '', orderItemId } = useRouteParams('reviewWrite');
  return (
    <PageShell title="评价商品" withBar>
      <LoginCard
        reason="登录后评价"
        redirect={{
          route: 'reviewWrite',
          params: { orderId, ...(orderItemId ? { orderItemId } : {}) },
        }}
      >
        {orderId ? (
          <ReviewForm orderId={orderId} only={orderItemId} />
        ) : (
          <Empty image="order" title="没有找到这个订单" />
        )}
      </LoginCard>
    </PageShell>
  );
}

function ReviewForm({ orderId, only }: { orderId: string; only?: string | undefined }) {
  const signedIn = useSignedIn();
  const client = useApiClient();
  const invalidate = useInvalidateRoutes();
  const queryClient = useQueryClient();
  const detail = useRouteQuery('order.detail', { params: { id: orderId } }, { enabled: signedIn });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [serviceScore, setServiceScore] = useState(5);
  const [outcomes, setOutcomes] = useState<Record<string, LineOutcome>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  if (detail.isError) {
    return <ErrorBlock error={detail.error} onRetry={() => detail.refetch()} />;
  }
  if (!detail.data) return <CellSkeleton rows={6} />;
  const lines = reviewLines(detail.data, only);
  if (lines.length === 0) {
    return (
      <Empty
        image="order"
        title="暂时不能评价"
        description="确认收货后可以评价已购买的商品"
        actions={
          <Button variant="outline" size="md" onClick={() => goBack()}>
            返回
          </Button>
        }
      />
    );
  }

  const draftOf = (id: string): Draft => drafts[id] ?? { productScore: 5, content: '', images: [] };
  const update = (id: string, patch: Partial<Draft>) =>
    setDrafts((all) => ({ ...all, [id]: { ...draftOf(id), ...patch } }));
  const outcomeOf = (line: StorefrontOrderItem): LineOutcome | undefined =>
    outcomes[line.id] ?? (line.reviewed ? 'already' : undefined);
  const remaining = lines.filter((line) => outcomeOf(line) === undefined);

  if (remaining.length === 0) {
    const held = Object.values(outcomes).includes('pending');
    const submitted = Object.values(outcomes).some((outcome) => outcome !== 'already');
    return (
      <Result
        id="review-result"
        status="success"
        title={held ? '评价已提交，审核后展示' : submitted ? '评价成功' : '已经评价过了'}
        description={submitted ? '感谢你的评价' : '这些商品都已评价'}
        actions={
          <Button
            variant="primary"
            size="lg"
            block
            // Back to 订单详情 when 去评价 was tapped there, rather than a second copy of it.
            onClick={() => leaveFor({ route: 'order', params: { id: orderId } })}
          >
            返回订单
          </Button>
        }
      />
    );
  }

  const busy = Object.values(uploading).some(Boolean);
  const submit = async () => {
    if (submitting) return;
    if (busy) {
      toast.text('图片还在上传，请稍候');
      return;
    }
    setSubmitting(true);
    const done: Record<string, LineOutcome> = {};
    try {
      for (const line of remaining) {
        const draft = draftOf(line.id);
        const content = draft.content.trim();
        try {
          const review = await client.call('catalog.reviewSubmit', {
            body: {
              orderItemId: line.id,
              productScore: draft.productScore,
              serviceScore,
              ...(content ? { content } : {}),
              images: draft.images,
            },
          });
          done[line.id] = review.moderation;
        } catch (error) {
          if (
            isApiError(error, 'catalog.reviewSubmit') &&
            error.code === 'CATALOG_REVIEW_ALREADY_WRITTEN'
          ) {
            done[line.id] = 'already';
            continue;
          }
          toast.text(errorMessage(error, '提交失败，请稍后重试'));
          break;
        }
      }
    } finally {
      setOutcomes((all) => ({ ...all, ...done }));
      setSubmitting(false);
      // A published review shows on the product at once (商品评价, 商品详情's first two and its
      // summary), and leaves 待评价 on 我的's 订单入口.
      if (Object.keys(done).length > 0) {
        markStale(queryClient, ...DECOR_PAGE_READS);
        void invalidate(
          ...ORDER_READS,
          'catalog.myReviews',
          'catalog.productReviews',
          'catalog.productReviewSummary',
          'catalog.productDetail',
        );
      }
    }
  };

  return (
    <View className="review">
      {lines.map((line) => {
        const outcome = outcomeOf(line);
        const draft = draftOf(line.id);
        return (
          <Card key={line.id} className="review__card">
            <OrderItemRow item={line} />
            {outcome ? (
              <Text className="review__done">
                {outcome === 'pending' ? '评价已提交，审核后展示' : '已评价'}
              </Text>
            ) : (
              <>
                <Stars
                  label="商品评分"
                  value={draft.productScore}
                  onChange={(productScore) => update(line.id, { productScore })}
                />
                <Textarea
                  label="评价内容"
                  value={draft.content}
                  maxLength={MAX_TEXT}
                  placeholder="说说使用感受，帮助其他买家参考（选填）"
                  onChange={(content) => update(line.id, { content })}
                />
                <ImageUploader
                  purpose="review"
                  max={9}
                  label="添加图片"
                  value={draft.images}
                  onChange={(images) => update(line.id, { images })}
                  onBusyChange={(value) => setUploading((all) => ({ ...all, [line.id]: value }))}
                />
              </>
            )}
          </Card>
        );
      })}
      <Card className="review__card">
        <Stars label="服务评分" value={serviceScore} onChange={setServiceScore} />
        <Text className="review__hint">评价不显示你的昵称和头像</Text>
      </Card>
      <View className="review__bar">
        <Button
          id="review-submit"
          variant="primary"
          size="lg"
          block
          loading={submitting}
          onClick={() => submit()}
        >
          提交评价
        </Button>
      </View>
    </View>
  );
}

function Stars({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <View className="review__stars" ariaRole="radiogroup" ariaLabel={label}>
      <Text className="review__stars-label">{label}</Text>
      {[1, 2, 3, 4, 5].map((score) => (
        <Pressable
          key={score}
          role="radio"
          checked={score === value}
          label={`${label} ${score} 星`}
          pressedTint={false}
          className="review__star"
          onClick={() => onChange(score)}
        >
          <Icon
            name={score <= value ? 'star-fill' : 'star'}
            className={
              score <= value ? 'review__star-icon review__star-icon--on' : 'review__star-icon'
            }
          />
        </Pressable>
      ))}
      <Text className="review__stars-word">{SCORE_WORDS[value]}</Text>
    </View>
  );
}
