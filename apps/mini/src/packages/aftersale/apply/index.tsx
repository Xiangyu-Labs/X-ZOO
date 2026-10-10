import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Text, View } from '@tarojs/components';
import type {
  RefundableItem,
  RefundableItemsResult,
  RefundKind,
} from '@shop/contracts/refund/schemas';
import { useApiClient, useInvalidateRoutes, useRouteQuery } from '@shop/api-client/react';
import { DECOR_PAGE_READS, markStale } from '@/data/stale-reads';
import { errorMessage } from '@/lib/error-message';
import { formatSpec } from '@/lib/spec';
import { navigate, subscribe, useRouteParams } from '@/platform';
import { LoginCard } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Cell, CellGroup } from '@/ui/cell';
import { Checkbox, Radio } from '@/ui/choice';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { toast } from '@/ui/feedback';
import { Textarea } from '@/ui/field';
import { Image } from '@/ui/image';
import { ImageUploader } from '@/ui/image-uploader';
import { PageShell } from '@/ui/page-shell';
import { Price } from '@/ui/price';
import { Sheet } from '@/ui/sheet';
import { CellSkeleton } from '@/ui/skeleton';
import { Stepper } from '@/ui/stepper';
import { REFUND_READS } from '../shared/actions';
import { fromCents, KIND_TEXT, lineEstimate, toCents } from '../shared/refund';
import './index.scss';

const BLOCKED_TEXT: Record<string, string> = {
  REFUND_ALREADY_OPEN: '已有售后处理中',
  REFUND_LINE_INVALID: '已全部退款',
};

export interface ApplyChoice {
  /** orderItemId → units. A line not in it is not selected. */
  quantities: Record<string, number>;
}

/** The lines a new request can take. */
export function selectable(items: readonly RefundableItem[]): RefundableItem[] {
  return items.filter((item) => item.blockedReason === null && item.refundableQuantity > 0);
}

/**
 * Freight goes back only when nothing shipped (the server's rule, `freightRefundable`) and the
 * request takes everything still refundable: a whole order undone before it left.
 */
export function includesFreight(data: RefundableItemsResult, quantities: Record<string, number>) {
  if (!data.freightRefundable || toCents(data.freightAmount) <= 0) return false;
  return selectable(data.items).every(
    (item) => (quantities[item.orderItemId] ?? 0) >= item.refundableQuantity,
  );
}

/** 预计退款, in cents: the lines' shares plus freight, never above what is left to refund. */
export function estimate(data: RefundableItemsResult, quantities: Record<string, number>): number {
  let cents = 0;
  for (const item of data.items) cents += lineEstimate(item, quantities[item.orderItemId] ?? 0);
  if (includesFreight(data, quantities)) cents += toCents(data.freightAmount);
  return Math.min(cents, toCents(data.refundableAmount));
}

/**
 * 申请售后 (`refundApply`, `packages/aftersale/apply/index?orderId=&orderItemId=`). Pick the
 * lines and how many, 仅退款 or 退货退款 (only when something shipped), a reason, words and up
 * to 6 pictures. There is no amount to type: the server works it out, and the page shows an
 * estimate from the refundable amounts. Submitting asks for the refund notices (C08).
 */
export default function RefundApplyPage() {
  const { orderId = '', orderItemId } = useRouteParams('refundApply');
  return (
    <PageShell title="申请售后" withBar>
      <LoginCard
        reason="登录后申请售后"
        redirect={{
          route: 'refundApply',
          params: { orderId, ...(orderItemId ? { orderItemId } : {}) },
        }}
      >
        {orderId ? (
          <ApplyForm orderId={orderId} only={orderItemId} />
        ) : (
          <Empty image="order" title="没有找到这个订单" />
        )}
      </LoginCard>
    </PageShell>
  );
}

function ApplyForm({ orderId, only }: { orderId: string; only?: string | undefined }) {
  const signedIn = useSignedIn();
  const items = useRouteQuery(
    'refund.applicableItems',
    { params: { orderId } },
    { enabled: signedIn },
  );
  const reasons = useRouteQuery('refund.reasons');

  if (items.isError) return <ErrorBlock error={items.error} onRetry={() => items.refetch()} />;
  if (!items.data) return <CellSkeleton rows={6} />;
  if (selectable(items.data.items).length === 0) {
    return (
      <Empty
        image="order"
        title="没有可以申请售后的商品"
        description="商品可能已退款，或已有售后正在处理"
        actions={
          <Button
            variant="outline"
            size="md"
            onClick={() => navigate({ route: 'refundList', params: {} })}
          >
            查看我的售后
          </Button>
        }
      />
    );
  }
  return <Form data={items.data} reasons={reasons.data?.items ?? []} only={only} />;
}

function initialQuantities(data: RefundableItemsResult, only?: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of selectable(data.items)) {
    if (only === undefined || item.orderItemId === only) {
      out[item.orderItemId] = item.refundableQuantity;
    }
  }
  return out;
}

function Form({
  data,
  reasons,
  only,
}: {
  data: RefundableItemsResult;
  reasons: readonly string[];
  only?: string | undefined;
}) {
  const client = useApiClient();
  const invalidate = useInvalidateRoutes();
  const queryClient = useQueryClient();
  const [quantities, setQuantities] = useState(() => initialQuantities(data, only));
  const chosen = data.items.filter((item) => (quantities[item.orderItemId] ?? 0) > 0);
  const anyShipped = chosen.some((item) => item.shippedQuantity > 0);
  const [kindPicked, setKind] = useState<RefundKind>('return_and_refund');
  const kind: RefundKind = anyShipped ? kindPicked : 'refund_only';
  const [reason, setReason] = useState('');
  const [picking, setPicking] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const toggle = (item: RefundableItem, on: boolean) =>
    setQuantities((all) => {
      const next = { ...all };
      if (on) next[item.orderItemId] = item.refundableQuantity;
      else delete next[item.orderItemId];
      return next;
    });

  const submit = async () => {
    const lines = Object.entries(quantities)
      .filter(([, quantity]) => quantity > 0)
      .map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
    const words = explanation.trim();
    const refund = await client.call('refund.apply', {
      body: {
        orderId: data.orderId,
        kind,
        lines,
        reason,
        ...(words ? { explanation: words } : {}),
        images,
        includeFreight: includesFreight(data, quantities),
      },
    });
    toast.success('申请已提交');
    markStale(queryClient, ...DECOR_PAGE_READS);
    await invalidate(...REFUND_READS);
    await navigate({ route: 'refund', params: { id: refund.id } }, { replace: true });
  };

  const onSubmit = () => {
    if (submitting) return;
    if (chosen.length === 0) {
      toast.text('请选择要售后的商品');
      return;
    }
    if (!reason) {
      toast.text('请选择售后原因');
      return;
    }
    if (uploading) {
      toast.text('图片还在上传，请稍候');
      return;
    }
    // In the tap, before anything is awaited (C08).
    const asked = subscribe('refundApply');
    setSubmitting(true);
    return submit()
      .catch((error: unknown) => {
        toast.text(errorMessage(error, '提交失败，请稍后重试'));
      })
      .finally(() => {
        setSubmitting(false);
        return asked;
      });
  };

  const cents = estimate(data, quantities);
  const freight = includesFreight(data, quantities);

  return (
    <View className="refund-apply" id="refund-apply">
      <Card title="选择商品">
        {data.items.map((item) => {
          const blocked = item.blockedReason !== null || item.refundableQuantity <= 0;
          const quantity = quantities[item.orderItemId] ?? 0;
          return (
            <View
              key={item.orderItemId}
              className={
                blocked ? 'refund-apply__item refund-apply__item--blocked' : 'refund-apply__item'
              }
            >
              <Checkbox
                checked={quantity > 0}
                disabled={blocked}
                label={`选择 ${item.productName}`}
                onChange={(on) => toggle(item, on)}
              >
                <View />
              </Checkbox>
              <View className="refund-apply__thumb">
                <Image src={item.productImageUrl} radius="sm" size="small" />
              </View>
              <View className="refund-apply__info">
                <Text className="refund-apply__name">{item.productName}</Text>
                {item.specText ? (
                  <Text className="refund-apply__spec">{formatSpec(item.specText)}</Text>
                ) : null}
                {blocked ? (
                  <Text className="refund-apply__blocked">
                    {BLOCKED_TEXT[item.blockedReason ?? ''] ?? '暂不可申请'}
                  </Text>
                ) : quantity > 0 && item.refundableQuantity > 1 ? (
                  <Stepper
                    label="售后数量"
                    value={quantity}
                    min={1}
                    max={item.refundableQuantity}
                    onChange={(value) =>
                      setQuantities((all) => ({ ...all, [item.orderItemId]: value }))
                    }
                  />
                ) : (
                  <Text className="refund-apply__spec">可退 {item.refundableQuantity} 件</Text>
                )}
              </View>
            </View>
          );
        })}
      </Card>

      <CellGroup>
        <Cell
          title="售后类型"
          value={
            anyShipped ? (
              <View className="refund-apply__kinds">
                {(['refund_only', 'return_and_refund'] as const).map((value) => (
                  <Radio
                    key={value}
                    label={KIND_TEXT[value]}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                  />
                ))}
              </View>
            ) : (
              <Text>{KIND_TEXT.refund_only}</Text>
            )
          }
        />
        <Cell
          title="售后原因"
          required
          value={reason || <Text className="refund-apply__placeholder">请选择</Text>}
          label={reason ? `售后原因 ${reason}` : '选择售后原因'}
          onClick={() => setPicking(true)}
        />
        <Cell
          title="预计退款"
          description={freight ? '含运费，最终以商家审核为准' : '最终以商家审核为准'}
          value={<Price value={fromCents(cents)} />}
        />
      </CellGroup>

      <Card title="补充说明">
        <Textarea
          label="补充说明"
          value={explanation}
          maxLength={200}
          placeholder="请描述遇到的问题（选填）"
          onChange={setExplanation}
        />
        <View className="refund-apply__images">
          <ImageUploader
            purpose="refund"
            max={6}
            label="上传凭证"
            value={images}
            onChange={setImages}
            onBusyChange={setUploading}
          />
        </View>
      </Card>

      <View className="refund-apply__bar">
        <Button
          id="refund-apply-submit"
          variant="primary"
          size="lg"
          block
          loading={submitting}
          onClick={onSubmit}
        >
          提交申请
        </Button>
      </View>

      <Sheet visible={picking} onClose={() => setPicking(false)} title="售后原因" height="tall">
        <View className="refund-apply__reasons">
          {reasons.map((value) => (
            <Radio
              key={value}
              label={value}
              checked={reason === value}
              className="refund-apply__reason"
              onChange={() => {
                setReason(value);
                setPicking(false);
              }}
            />
          ))}
          {reasons.length === 0 ? (
            <Radio
              label="其他"
              checked={reason === '其他'}
              onChange={() => {
                setReason('其他');
                setPicking(false);
              }}
            />
          ) : null}
        </View>
      </Sheet>
      <Text className="refund-apply__order">订单编号 {data.orderNo}</Text>
    </View>
  );
}
